import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { ResolvedBrowserConfig } from "./config.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  type ProfileContext,
} from "./server-context.js";

export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};

/**
 * Default Docker bridge gateway IP (linux). When binding to 0.0.0.0, containers
 * need this IP to reach the host.
 */
const DEFAULT_DOCKER_BRIDGE_IP = "172.17.0.1";

export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  /**
   * When true (sandbox mode), binds to 0.0.0.0 and advertises docker bridge IP.
   * This allows containers to reach the bridge server on the host.
   */
  sandboxMode?: boolean;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
}): Promise<BrowserBridge> {
  // In sandbox mode, bind to all interfaces so containers can reach us
  const bindHost = params.sandboxMode ? "0.0.0.0" : (params.host ?? "127.0.0.1");
  const port = params.port ?? 0;

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const authToken = params.authToken?.trim();
  if (authToken) {
    app.use((req, res, next) => {
      const auth = String(req.headers.authorization ?? "").trim();
      if (auth === `Bearer ${authToken}`) {
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
    const s = app.listen(port, bindHost, () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort;

  // When bound to 0.0.0.0 (sandbox mode), advertise the docker bridge IP
  // so containers can reach us. Otherwise use the explicit host or localhost.
  const advertisedHost =
    bindHost === "0.0.0.0" ? DEFAULT_DOCKER_BRIDGE_IP : (params.host ?? "127.0.0.1");
  const baseUrl = `http://${advertisedHost}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
