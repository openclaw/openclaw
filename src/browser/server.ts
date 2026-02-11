import type { Server } from "node:http";
import express from "express";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqual } from "../security/safe-equal.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { registerBrowserRoutes } from "./routes/index.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";

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

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Host header validation (DNS rebinding protection)
  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (
      host &&
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "[::1]" &&
      host !== "::1"
    ) {
      res.status(403).json({ error: "Forbidden: invalid Host header" });
      return;
    }
    next();
  });

  // Bearer token auth (secure by default)
  if (resolved.auth.enabled && resolved.auth.token) {
    const expectedAuth = `Bearer ${resolved.auth.token}`;
    app.use((req, res, next) => {
      const auth = String(req.headers.authorization ?? "").trim();
      if (safeEqual(auth, expectedAuth)) {
        return next();
      }
      res.status(401).json({ error: "Unauthorized" });
    });
    logServer.info(`Browser control auth enabled (token: ${resolved.auth.token.slice(0, 8)}…)`);
  } else {
    logServer.warn(
      "Browser control auth is DISABLED. Any local process can control the browser. " +
        "Set browser.auth.enabled: true in your config for security.",
    );
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
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

  logServer.info(`Browser control listening on http://127.0.0.1:${port}/`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
  });

  try {
    const current = state;
    if (current) {
      for (const name of Object.keys(current.resolved.profiles)) {
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

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}

/** Get the browser control auth token (for internal consumers). */
export function getBrowserControlAuthToken(): string | null {
  return state?.resolved.auth.token ?? null;
}
