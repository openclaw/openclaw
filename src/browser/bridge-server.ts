import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { ResolvedBrowserConfig } from "./config.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  type ProfileContext,
} from "./server-context.js";

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

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
}): Promise<BrowserBridge> {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;

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

  const authToken = params.authToken?.trim() || undefined;
  const authPassword = params.authPassword?.trim() || undefined;
  if (authToken || authPassword) {
    app.use((req, res, next) => {
      if (isAuthorizedBrowserRequest(req, { token: authToken, password: authPassword })) {
        return next();
      }
      res.status(401).send("Unauthorized");
    });
  }

  const state: BrowserServerState = {
    server: null as unknown as Server,
    port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  const ctx = createBrowserRouteContext({
    getState: () => state,
    onEnsureAttachTarget: params.onEnsureAttachTarget,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort;

  const baseUrl = `http://${host}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
