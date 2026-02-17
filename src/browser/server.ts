import type { Server } from "node:http";
import express from "express";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./control-auth.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }

  let browserAuth = resolveBrowserControlAuth(cfg);
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    browserAuth = ensured.auth;
    if (ensured.generatedToken) {
      logServer.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
  }

  const app = express();
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, browserAuth);

  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  state = {
    server,
    port,
    resolved,
    profiles: new Map(),
  };

  // If any profile uses the Chrome extension relay, start the local relay server eagerly
  // so the extension can connect before the first browser action.
  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
      logServer.warn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }

  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });

  try {
    const current = state;
    if (current) {
      for (const name of listKnownProfileNames(current)) {
        try {
          await ctx.forProfile(name).stopRunningBrowser();
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    logServer.warn(`openclaw browser stop failed: ${String(err)}`);
  }

  if (current.server) {
    await new Promise<void>((resolve) => {
      current.server?.close(() => resolve());
    });
  }
  state = null;

  // Optional: avoid importing heavy Playwright bridge when this process never used it.
  if (isPwAiLoaded()) {
    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection();
    } catch {
      // ignore
    }
  }
}
