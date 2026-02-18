import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMime } from "../media/mime.js";
import { resolveFileWithinRoot } from "./file-resolver.js";

export const A2UI_PATH = "/__openclaw__/a2ui";

export const CANVAS_HOST_PATH = "/__openclaw__/canvas";

export const CANVAS_WS_PATH = "/__openclaw__/ws";

export function getA2uiRootCandidates(opts: {
  moduleDir: string;
  cwd?: string;
  execPath?: string;
}): string[] {
  const moduleDir = path.resolve(opts.moduleDir);
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  const candidates = [
    // Running from source (bun) or dist (tsc + copied assets).
    path.resolve(moduleDir, "a2ui"),

    // Bundled dist entrypoint (e.g. dist/entry.js) still needs to find dist/canvas-host/a2ui.
    path.resolve(moduleDir, "canvas-host", "a2ui"),
    path.resolve(moduleDir, "../canvas-host/a2ui"),

    // Running from dist without copied assets (fallback to source).
    path.resolve(moduleDir, "../../src/canvas-host/a2ui"),

    // Running from repo root.
    path.resolve(cwd, "src/canvas-host/a2ui"),
    path.resolve(cwd, "dist/canvas-host/a2ui"),

    // Historical/packaged layouts.
    path.resolve(cwd, "dist/a2ui"),
  ];

  if (opts.execPath) {
    // Packaged app layouts sometimes place assets alongside the node executable.
    candidates.unshift(path.resolve(path.dirname(opts.execPath), "a2ui"));
  }

  // Dedupe while preserving order.
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const resolved = path.resolve(c);
    if (seen.has(resolved)) {
      return false;
    }
    seen.add(resolved);
    return true;
  });
}

export async function resolveA2uiRootFromCandidates(candidates: string[]): Promise<string | null> {
  for (const dir of candidates) {
    try {
      const indexPath = path.join(dir, "index.html");
      const bundlePath = path.join(dir, "a2ui.bundle.js");
      await fs.stat(indexPath);
      await fs.stat(bundlePath);
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

export function createA2uiRootRealResolver(deps: {
  resolveRoot: () => Promise<string | null>;
  realpath: (p: string) => Promise<string>;
}): () => Promise<string | null> {
  let cached: string | undefined;
  let inflight: Promise<string | null> | null = null;

  return async () => {
    if (cached) {
      return cached;
    }
    if (inflight) {
      return inflight;
    }

    inflight = (async () => {
      try {
        const root = await deps.resolveRoot();
        if (!root) {
          // Important: do NOT cache null (transient fs issues / post-install fixes should recover).
          return null;
        }
        const real = await deps.realpath(root);
        cached = real;
        return real;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  };
}

async function resolveA2uiRoot(): Promise<string | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = getA2uiRootCandidates({
    moduleDir,
    cwd: process.cwd(),
    execPath: process.execPath,
  });
  return await resolveA2uiRootFromCandidates(candidates);
}

const resolveA2uiRootReal = createA2uiRootRealResolver({
  resolveRoot: resolveA2uiRoot,
  realpath: fs.realpath,
});

export function injectCanvasLiveReload(html: string): string {
  const snippet = `
<script>
(() => {
  // Cross-platform action bridge helper.
  // Works on:
  // - iOS: window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(...)
  // - Android: window.openclawCanvasA2UIAction.postMessage(...)
  const handlerNames = ["openclawCanvasA2UIAction"];
  function postToNode(payload) {
    try {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      for (const name of handlerNames) {
        const iosHandler = globalThis.webkit?.messageHandlers?.[name];
        if (iosHandler && typeof iosHandler.postMessage === "function") {
          iosHandler.postMessage(raw);
          return true;
        }
        const androidHandler = globalThis[name];
        if (androidHandler && typeof androidHandler.postMessage === "function") {
          // Important: call as a method on the interface object (binding matters on Android WebView).
          androidHandler.postMessage(raw);
          return true;
        }
      }
    } catch {}
    return false;
  }
  function sendUserAction(userAction) {
    const id =
      (userAction && typeof userAction.id === "string" && userAction.id.trim()) ||
      (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    const action = { ...userAction, id };
    return postToNode({ userAction: action });
  }
  globalThis.OpenClaw = globalThis.OpenClaw ?? {};
  globalThis.OpenClaw.postMessage = postToNode;
  globalThis.OpenClaw.sendUserAction = sendUserAction;
  globalThis.openclawPostMessage = postToNode;
  globalThis.openclawSendUserAction = sendUserAction;

  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + ${JSON.stringify(CANVAS_WS_PATH)});
    ws.onmessage = (ev) => {
      if (String(ev.data || "") === "reload") location.reload();
    };
  } catch {}
})();
</script>
`.trim();

  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx >= 0) {
    return `${html.slice(0, idx)}\n${snippet}\n${html.slice(idx)}`;
  }
  return `${html}\n${snippet}\n`;
}

export async function handleA2uiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath =
    url.pathname === A2UI_PATH || url.pathname.startsWith(`${A2UI_PATH}/`) ? A2UI_PATH : undefined;
  if (!basePath) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const a2uiRootReal = await resolveA2uiRootReal();
  if (!a2uiRootReal) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("A2UI assets not found");
    return true;
  }

  const rel = url.pathname.slice(basePath.length);
  const result = await resolveFileWithinRoot(a2uiRootReal, rel || "/");
  if (!result) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  try {
    const lower = result.realPath.toLowerCase();
    const mime =
      lower.endsWith(".html") || lower.endsWith(".htm")
        ? "text/html"
        : ((await detectMime({ filePath: result.realPath })) ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "HEAD") {
      res.setHeader("Content-Type", mime === "text/html" ? "text/html; charset=utf-8" : mime);
      res.end();
      return true;
    }

    if (mime === "text/html") {
      const buf = await result.handle.readFile({ encoding: "utf8" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(injectCanvasLiveReload(buf));
      return true;
    }

    res.setHeader("Content-Type", mime);
    res.end(await result.handle.readFile());
    return true;
  } finally {
    await result.handle.close().catch(() => {});
  }
}
