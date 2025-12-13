import type { Server } from "node:http";
import path from "node:path";
import express from "express";

import { loadConfig } from "../config/config.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { ensureMediaDir, saveMediaBuffer } from "../media/store.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { captureScreenshotPng } from "./cdp.js";
import {
  isChromeReachable,
  launchClawdChrome,
  type RunningChrome,
  stopClawdChrome,
} from "./chrome.js";
import {
  resolveBrowserConfig,
  shouldStartLocalBrowserServer,
} from "./config.js";

export type BrowserTab = {
  targetId: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

type BrowserServerState = {
  server: Server;
  port: number;
  cdpPort: number;
  running: RunningChrome | null;
  resolved: ReturnType<typeof resolveBrowserConfig>;
};

let state: BrowserServerState | null = null;

function jsonError(res: express.Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

async function fetchJson<T>(url: string, timeoutMs = 1500): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function listTabs(cdpPort: number): Promise<BrowserTab[]> {
  const raw = await fetchJson<
    Array<{
      id?: string;
      title?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
      type?: string;
    }>
  >(`http://127.0.0.1:${cdpPort}/json/list`);
  return raw
    .map((t) => ({
      targetId: t.id ?? "",
      title: t.title ?? "",
      url: t.url ?? "",
      wsUrl: t.webSocketDebuggerUrl,
      type: t.type,
    }))
    .filter((t) => Boolean(t.targetId));
}

async function openTab(cdpPort: number, url: string): Promise<BrowserTab> {
  const encoded = encodeURIComponent(url);
  const created = await fetchJson<{
    id?: string;
    title?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
    type?: string;
  }>(`http://127.0.0.1:${cdpPort}/json/new?${encoded}`);

  if (!created.id) throw new Error("Failed to open tab (missing id)");
  return {
    targetId: created.id,
    title: created.title ?? "",
    url: created.url ?? url,
    wsUrl: created.webSocketDebuggerUrl,
    type: created.type,
  };
}

async function activateTab(cdpPort: number, targetId: string): Promise<void> {
  await fetchJson(`http://127.0.0.1:${cdpPort}/json/activate/${targetId}`);
}

async function closeTab(cdpPort: number, targetId: string): Promise<void> {
  await fetchJson(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`);
}

async function ensureBrowserAvailable(runtime: RuntimeEnv): Promise<void> {
  if (!state) throw new Error("Browser server not started");
  if (await isChromeReachable(state.cdpPort)) return;
  if (state.resolved.attachOnly) {
    throw new Error("Browser attachOnly is enabled and no browser is running.");
  }

  const launched = await launchClawdChrome(state.resolved, runtime);
  state.running = launched;
  launched.proc.on("exit", () => {
    if (state?.running?.pid === launched.pid) {
      state.running = null;
    }
  });
  return;
}

export async function startBrowserControlServerFromConfig(
  runtime: RuntimeEnv = defaultRuntime,
): Promise<BrowserServerState | null> {
  if (state) return state;

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  if (!resolved.enabled) return null;

  if (!shouldStartLocalBrowserServer(resolved)) {
    logInfo(
      `browser control URL is non-loopback (${resolved.controlUrl}); skipping local server start`,
      runtime,
    );
    return null;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", async (_req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const reachable = await isChromeReachable(state.cdpPort, 300);
    res.json({
      enabled: state.resolved.enabled,
      controlUrl: state.resolved.controlUrl,
      running: reachable,
      pid: state.running?.pid ?? null,
      cdpPort: state.cdpPort,
      chosenBrowser: state.running?.exe.kind ?? null,
      userDataDir: state.running?.userDataDir ?? null,
      color: state.resolved.color,
      headless: state.resolved.headless,
      attachOnly: state.resolved.attachOnly,
    });
  });

  app.post("/start", async (_req, res) => {
    try {
      await ensureBrowserAvailable(runtime);
      res.json({ ok: true });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.post("/stop", async (_req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    if (!state.running) return res.json({ ok: true, stopped: false });
    try {
      await stopClawdChrome(state.running);
      state.running = null;
      res.json({ ok: true, stopped: true });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.get("/tabs", async (_req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const reachable = await isChromeReachable(state.cdpPort, 300);
    if (!reachable)
      return res.json({ running: false, tabs: [] as BrowserTab[] });
    try {
      const tabs = await listTabs(state.cdpPort);
      res.json({ running: true, tabs });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.post("/tabs/open", async (req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const url = String((req.body as { url?: unknown })?.url ?? "").trim();
    if (!url) return jsonError(res, 400, "url is required");
    try {
      await ensureBrowserAvailable(runtime);
      const tab = await openTab(state.cdpPort, url);
      res.json(tab);
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.post("/tabs/focus", async (req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const targetId = String(
      (req.body as { targetId?: unknown })?.targetId ?? "",
    ).trim();
    if (!targetId) return jsonError(res, 400, "targetId is required");
    const reachable = await isChromeReachable(state.cdpPort, 300);
    if (!reachable) return jsonError(res, 409, "browser not running");
    try {
      await activateTab(state.cdpPort, targetId);
      res.json({ ok: true });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.delete("/tabs/:targetId", async (req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const targetId = String(req.params.targetId ?? "").trim();
    if (!targetId) return jsonError(res, 400, "targetId is required");
    const reachable = await isChromeReachable(state.cdpPort, 300);
    if (!reachable) return jsonError(res, 409, "browser not running");
    try {
      await closeTab(state.cdpPort, targetId);
      res.json({ ok: true });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  app.get("/screenshot", async (req, res) => {
    if (!state) return jsonError(res, 503, "browser server not started");
    const targetId =
      typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const fullPage =
      req.query.fullPage === "true" || req.query.fullPage === "1";

    const reachable = await isChromeReachable(state.cdpPort, 300);
    if (!reachable) return jsonError(res, 409, "browser not running");

    try {
      const tabs = await listTabs(state.cdpPort);
      const chosen = targetId
        ? tabs.find((t) => t.targetId === targetId)
        : tabs.at(0);
      if (!chosen?.wsUrl) return jsonError(res, 404, "tab not found");

      const png = await captureScreenshotPng({ wsUrl: chosen.wsUrl, fullPage });
      await ensureMediaDir();
      const saved = await saveMediaBuffer(png, "image/png", "browser");
      const filePath = path.resolve(saved.path);
      res.json({
        ok: true,
        path: filePath,
        targetId: chosen.targetId,
        url: chosen.url,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logError(
      `clawd browser server failed to bind 127.0.0.1:${port}: ${String(err)}`,
    );
    return null;
  });

  if (!server) return null;

  state = {
    server,
    port,
    cdpPort: resolved.cdpPort,
    running: null,
    resolved,
  };

  logInfo(
    `🦞 clawd browser control listening on http://127.0.0.1:${port}/`,
    runtime,
  );
  return state;
}

export async function stopBrowserControlServer(
  runtime: RuntimeEnv = defaultRuntime,
) {
  if (!state) return;
  const current = state;
  state = null;
  try {
    if (current.running) {
      await stopClawdChrome(current.running).catch((err) =>
        logWarn(`clawd browser stop failed: ${String(err)}`, runtime),
      );
    }
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
}
