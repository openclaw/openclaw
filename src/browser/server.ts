import type { Server } from "node:http";
import express from "express";

import { loadConfig } from "../config/config.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  resolveBrowserConfig,
  shouldStartLocalBrowserServer,
} from "./config.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
} from "./server-context.js";

let state: BrowserServerState | null = null;

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

  const ctx = createBrowserRouteContext({
    runtime,
    getState: () => state,
    setRunning: (running) => {
      if (state) state.running = running;
    },
  });
  registerBrowserRoutes(app, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logError(
      `clawd browser server failed to bind 127.0.0.1:${port}: ${String(err)}`,
      runtime,
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
): Promise<void> {
  const current = state;
  if (!current) return;

  const ctx = createBrowserRouteContext({
    runtime,
    getState: () => state,
    setRunning: (running) => {
      if (state) state.running = running;
    },
  });

  try {
    await ctx.stopRunningBrowser();
  } catch (err) {
    logWarn(`clawd browser stop failed: ${String(err)}`, runtime);
  }

  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
  });
  state = null;

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
