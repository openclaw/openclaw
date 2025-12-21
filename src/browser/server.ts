import type { Server } from "node:http";
import express from "express";

import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
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
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  if (state) return state;

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  if (!resolved.enabled) return null;

  if (!shouldStartLocalBrowserServer(resolved)) {
    logServer.info(
      `browser control URL is non-loopback (${resolved.controlUrl}); skipping local server start`,
    );
    return null;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const ctx = createBrowserRouteContext({
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
    logServer.error(
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

  logServer.info(`Browser control listening on http://127.0.0.1:${port}/`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  if (!current) return;

  const ctx = createBrowserRouteContext({
    getState: () => state,
    setRunning: (running) => {
      if (state) state.running = running;
    },
  });

  try {
    await ctx.stopRunningBrowser();
  } catch (err) {
    logServer.warn(`clawd browser stop failed: ${String(err)}`);
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
