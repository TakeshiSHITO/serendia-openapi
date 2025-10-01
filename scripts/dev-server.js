#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const APIS = {
  user: 'contexts/user/openapi.yaml',
  admin: 'contexts/admin/openapi.yaml',
  shop: 'contexts/shop/openapi.yaml',
};

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

let sseClients = new Set();
let building = false;
let pending = false;
let buildQueue = new Set();

function buildOne(name, file) {
  return new Promise((resolve, reject) => {
    const out = path.join(DIST_DIR, `${name}.html`);
    const args = ['build-docs', file, '-o', out, '--title', `${name} API`];
    const bin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'redocly');
    const p = spawn(bin, args, { stdio: 'inherit' });
    p.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`redocly build-docs failed for ${name} (code ${code})`));
    });
  });
}

async function buildAll() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  try {
    const entries = Object.entries(APIS);
    for (const [name, file] of entries) {
      await buildOne(name, file);
    }
    broadcastReload();
  } catch (e) {
    console.error(e);
  } finally {
    building = false;
    if (pending) {
      pending = false;
      buildAll();
    }
  }
}

async function buildSome(names) {
  if (!names || names.size === 0) return;
  if (building) {
    // merge into queue and let current finish
    for (const n of names) buildQueue.add(n);
    pending = true;
    return;
  }
  building = true;
  try {
    for (const name of names) {
      const file = APIS[name];
      if (file) await buildOne(name, file);
    }
    broadcastReload();
  } catch (e) {
    console.error(e);
  } finally {
    building = false;
    if (buildQueue.size > 0) {
      const next = new Set(buildQueue);
      buildQueue.clear();
      buildSome(next);
    } else if (pending) {
      pending = false;
    }
  }
}

function scheduleBuildForPath(changedPath) {
  if (!changedPath) return;
  const p = changedPath.replace(/\\/g, '/');
  const names = new Set();
  if (p.includes('/contexts/user/')) names.add('user');
  if (p.includes('/contexts/admin/')) names.add('admin');
  if (p.includes('/contexts/shop/')) names.add('shop');
  if (p.endsWith('contexts/user/openapi.yaml')) names.add('user');
  if (p.endsWith('contexts/admin/openapi.yaml')) names.add('admin');
  if (p.endsWith('contexts/shop/openapi.yaml')) names.add('shop');
  if (p.includes('/shared/') || p.endsWith('/redocly.yaml') || p.endsWith('redocly.yaml')) {
    names.add('user'); names.add('admin'); names.add('shop');
  }
  if (names.size === 0) return;
  buildSome(names);
}

function broadcastReload() {
  const data = `event: reload\ndata: now\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) {}
  }
}

function serveIndex(res) {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>APIs</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto;margin:40px}a{display:block;margin:8px 0}</style>
  </head><body>
    <h1>OpenAPI Docs</h1>
    <a href="/user">User API</a>
    <a href="/admin">Admin API</a>
    <a href="/shop">Shop API</a>
    <script>
      const ev = new EventSource('/livereload');
      ev.addEventListener('reload', () => location.reload());
    </script>
  </body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function injectLiveReload(html) {
  const snippet = `<script>\nconst ev=new EventSource('/livereload');\nev.addEventListener('reload',()=>location.reload());\n</script>`;
  return html.replace(/<\/body>/i, `${snippet}</body>`);
}

function serveApi(name, res) {
  const file = path.join(DIST_DIR, `${name}.html`);
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Document not built yet for ${name}. Building... Please refresh.`);
      buildAll();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(injectLiveReload(data));
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/livereload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.url === '/' || req.url === '/index.html') return serveIndex(res);
  if (req.url === '/user') return serveApi('user', res);
  if (req.url === '/admin') return serveApi('admin', res);
  if (req.url === '/shop') return serveApi('shop', res);
  const ctxMatch = req.url && req.url.match(/^\/contexts\/(user|admin|shop)\/openapi/);
  if (ctxMatch) return serveApi(ctxMatch[1], res);

  // serve anything from dist as a fallback (e.g., assets if any in future)
  const fp = path.join(DIST_DIR, decodeURIComponent(req.url.replace(/^\//, '')));
  if (fp.startsWith(DIST_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    fs.createReadStream(fp).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

function tryListen(startPort, attemptsLeft = 10) {
  const port = startPort;
  server.once('error', (err) => {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EPERM') && attemptsLeft > 0) {
      const next = port + 1;
      console.warn(`Port ${port} failed (${err.code}). Trying ${next}...`);
      tryListen(next, attemptsLeft - 1);
    } else {
      console.error('Failed to start dev server:', err);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log(`Dev server listening on http://${HOST}:${port}`);
    if (port !== PORT) {
      console.log(`Tip: set PORT=${port} to reuse this port next time.`);
    }
    buildAll();
  });
}

tryListen(PORT);

// Watch for changes and rebuild
const watchTargets = [
  path.resolve(__dirname, '..', 'contexts'),
  path.resolve(__dirname, '..', 'shared'),
  path.resolve(__dirname, '..', 'redocly.yaml'),
];

for (const target of watchTargets) {
  try {
    const stat = fs.existsSync(target) && fs.statSync(target);
    if (!stat) continue;
    const recursive = stat.isDirectory();
    fs.watch(target, { recursive }, (event, filename) => {
      const full = filename ? path.join(target, filename) : target;
      scheduleBuildForPath(full);
    });
  } catch (e) {
    try {
      fs.watch(target, (event, filename) => {
        const full = filename ? path.join(target, filename) : target;
        scheduleBuildForPath(full);
      });
    } catch (_) {}
  }
}
