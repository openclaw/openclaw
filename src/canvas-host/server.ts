import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import { detectMime } from "../media/mime.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { handleA2uiHttpRequest, injectCanvasLiveReload } from "./a2ui.js";

export type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  port?: number;
  listenHost?: string;
  allowInTests?: boolean;
};

export type CanvasHostServer = {
  port: number;
  rootDir: string;
  close: () => Promise<void>;
};

const WS_PATH = "/__clawdis/ws";

function defaultIndexHTML() {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Clawdis Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px 18px 14px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.2px; }
  .sub { opacity: 0.75; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { appearance: none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.10); color: #fff; padding: 10px 12px; border-radius: 12px; font-weight: 600; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .ok { color: #24e08a; }
  .bad { color: #ff5c5c; }
  .log { margin-top: 14px; opacity: 0.85; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>Clawdis Canvas</h1>
      <div class="sub">Interactive test page (auto-reload enabled)</div>
    </div>

    <div class="row">
      <button id="btn-hello">Hello</button>
      <button id="btn-time">Time</button>
      <button id="btn-photo">Photo</button>
      <button id="btn-dalek">Dalek</button>
    </div>

    <div id="status" class="sub" style="margin-top: 10px;"></div>
    <div id="log" class="log">Ready.</div>
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const log = (msg) => { logEl.textContent = String(msg); };

  const hasIOS = () => !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.clawdisCanvasA2UIAction);
  const hasAndroid = () => !!(window.clawdisCanvasA2UIAction && typeof window.clawdisCanvasA2UIAction.postMessage === "function");
  const hasHelper = () => typeof window.clawdisSendUserAction === "function";
  statusEl.innerHTML =
    "Bridge: " +
    (hasHelper() ? "<span class='ok'>ready</span>" : "<span class='bad'>missing</span>") +
    " · iOS=" + (hasIOS() ? "yes" : "no") +
    " · Android=" + (hasAndroid() ? "yes" : "no");

  window.addEventListener("clawdis:a2ui-action-status", (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  });

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android Clawdis node canvas.");
      return;
    }
    const ok = window.clawdisSendUserAction({
      name,
      surfaceId: "main",
      sourceComponentId,
      context: { t: Date.now() },
    });
    log(ok ? ("Sent action: " + name) : ("Failed to send action: " + name));
  }

  document.getElementById("btn-hello").onclick = () => send("hello", "demo.hello");
  document.getElementById("btn-time").onclick = () => send("time", "demo.time");
  document.getElementById("btn-photo").onclick = () => send("photo", "demo.photo");
  document.getElementById("btn-dalek").onclick = () => send("dalek", "demo.dalek");
})();
</script>
`;
}

function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function resolveFilePath(rootReal: string, urlPath: string) {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) return null;

  let candidate = path.join(rootReal, rel);
  if (normalized.endsWith("/")) {
    candidate = path.join(candidate, "index.html");
  }

  try {
    const st = await fs.stat(candidate);
    if (st.isDirectory()) {
      candidate = path.join(candidate, "index.html");
    }
  } catch {
    // ignore
  }

  const rootPrefix = rootReal.endsWith(path.sep)
    ? rootReal
    : `${rootReal}${path.sep}`;
  try {
    const lstat = await fs.lstat(candidate);
    if (lstat.isSymbolicLink()) return null;
    const real = await fs.realpath(candidate);
    if (!real.startsWith(rootPrefix)) return null;
    return real;
  } catch {
    return null;
  }
}

function isDisabledByEnv() {
  if (process.env.CLAWDIS_SKIP_CANVAS_HOST === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST) return true;
  return false;
}

export async function startCanvasHost(
  opts: CanvasHostOpts,
): Promise<CanvasHostServer> {
  if (isDisabledByEnv() && opts.allowInTests !== true) {
    return { port: 0, rootDir: "", close: async () => {} };
  }

  const rootDir = resolveUserPath(
    opts.rootDir ?? path.join(os.homedir(), "clawd", "canvas"),
  );
  await ensureDir(rootDir);
  const rootReal = await fs.realpath(rootDir);
  try {
    const indexPath = path.join(rootReal, "index.html");
    await fs.stat(indexPath);
  } catch {
    try {
      await fs.writeFile(
        path.join(rootReal, "index.html"),
        defaultIndexHTML(),
        "utf8",
      );
    } catch {
      // ignore; we'll still serve the "missing file" message if needed.
    }
  }

  const bindHost = opts.listenHost?.trim() || "0.0.0.0";
  const app = express();
  app.disable("x-powered-by");

  app.get(/.*/, async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === WS_PATH) {
        res.status(426).send("upgrade required");
        return;
      }

      if (await handleA2uiHttpRequest(req, res)) return;

      const filePath = await resolveFilePath(rootReal, url.pathname);
      if (!filePath) {
        if (url.pathname === "/" || url.pathname.endsWith("/")) {
          res
            .status(404)
            .type("text/html")
            .send(
              `<!doctype html><meta charset="utf-8" /><title>Clawdis Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`,
            );
          return;
        }
        res.status(404).send("not found");
        return;
      }

      const lower = filePath.toLowerCase();
      const mime =
        lower.endsWith(".html") || lower.endsWith(".htm")
          ? "text/html"
          : (detectMime({ filePath }) ?? "application/octet-stream");

      res.setHeader("Cache-Control", "no-store");
      if (mime === "text/html") {
        const html = await fs.readFile(filePath, "utf8");
        res.type("text/html; charset=utf-8").send(injectCanvasLiveReload(html));
        return;
      }

      res.type(mime).send(await fs.readFile(filePath));
    } catch (err) {
      opts.runtime.error(`canvasHost request failed: ${String(err)}`);
      res.status(500).send("error");
    }
  });

  const server: Server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: WS_PATH });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });

  let debounce: NodeJS.Timeout | null = null;
  const broadcastReload = () => {
    for (const ws of sockets) {
      try {
        ws.send("reload");
      } catch {
        // ignore
      }
    }
  };
  const scheduleReload = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      broadcastReload();
    }, 75);
    debounce.unref?.();
  };

  const watcher = chokidar.watch(rootReal, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 10 },
    ignored: [
      /(^|[\\/])\../, // dotfiles
      /(^|[\\/])node_modules([\\/]|$)/,
    ],
  });
  watcher.on("all", () => scheduleReload());

  const listenPort =
    typeof opts.port === "number" && Number.isFinite(opts.port) && opts.port > 0
      ? opts.port
      : 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, bindHost);
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : 0;
  opts.runtime.log(
    `canvas host listening on http://${bindHost}:${boundPort} (root ${rootDir})`,
  );

  return {
    port: boundPort,
    rootDir,
    close: async () => {
      if (debounce) clearTimeout(debounce);
      await watcher.close().catch(() => {});
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
