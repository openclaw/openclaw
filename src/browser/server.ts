import type { IncomingMessage, Server } from "node:http";
import express from "express";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./control-auth.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import { registerBrowserRoutes } from "./routes/index.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function parseBearerToken(authorization: string): string | undefined {
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = authorization.slice(7).trim();
  return token || undefined;
}

function parseBasicPassword(authorization: string): string | undefined {
  if (!authorization || !authorization.toLowerCase().startsWith("basic ")) {
    return undefined;
  }
  const encoded = authorization.slice(6).trim();
  if (!encoded) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) {
      return undefined;
    }
    const password = decoded.slice(sep + 1).trim();
    return password || undefined;
  } catch {
    return undefined;
  }
}

function isAuthorizedBrowserRequest(
  req: IncomingMessage,
  auth: { token?: string; password?: string },
): boolean {
  const authorization = firstHeaderValue(req.headers.authorization).trim();

  if (auth.token) {
    const bearer = parseBearerToken(authorization);
    if (bearer && safeEqualSecret(bearer, auth.token)) {
      return true;
    }
  }

  if (auth.password) {
    const passwordHeader = firstHeaderValue(req.headers["x-openclaw-password"]).trim();
    if (passwordHeader && safeEqualSecret(passwordHeader, auth.password)) {
      return true;
    }

    const basicPassword = parseBasicPassword(authorization);
    if (basicPassword && safeEqualSecret(basicPassword, auth.password)) {
      return true;
    }
  }

  return false;
}

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
  app.use((req, res, next) => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(new Error("request aborted"));
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) {
        abort();
      }
    });
    // Make the signal available to browser route handlers (best-effort).
    (req as unknown as { signal?: AbortSignal }).signal = ctrl.signal;
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  if (browserAuth.token || browserAuth.password) {
    app.use((req, res, next) => {
      if (isAuthorizedBrowserRequest(req, browserAuth)) {
        return next();
      }
      res.status(401).send("Unauthorized");
    });
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
