import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { listenGatewayHttpServer } from "../server/http-listen.js";

/** Dedicated loopback ingress; registry lookup remains owned by the portal service. */
export function createPortalIngress(params: {
  port: number;
  httpServers: Server[];
  request: (req: IncomingMessage, res: ServerResponse) => void;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}): { start: () => Promise<number>; close: () => Promise<void> } {
  const server = createServer(params.request);
  server.on("upgrade", params.upgrade);
  let startup: Promise<number> | undefined;
  let closed = false;
  return {
    start: () => {
      if (closed) {
        return Promise.reject(new Error("Portal ingress is closed"));
      }
      // Registration and memoization precede binding, so concurrent opens share one listener.
      if (!startup) {
        params.httpServers.push(server);
        startup = (async () => {
          try {
            await listenGatewayHttpServer({
              httpServer: server,
              bindHost: "127.0.0.1",
              port: params.port,
              retryEaddrinuse: false,
              serviceName: "portal ingress",
              endpointScheme: "http",
            });
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Portal ingress did not resolve its listener port");
            }
            return address.port;
          } catch (error) {
            const index = params.httpServers.indexOf(server);
            if (index >= 0) {
              params.httpServers.splice(index, 1);
            }
            throw error;
          }
        })();
      }
      return startup;
    },
    close: async () => {
      closed = true;
      // Settle binding before closing: close during startup must not leave a late listener alive.
      await startup?.catch(() => undefined);
      const index = params.httpServers.indexOf(server);
      if (index >= 0) {
        params.httpServers.splice(index, 1);
      }
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}

/** Match only a single DNS hostname authority; forwarded headers never select a portal. */
export function portalIngressHostname(host: string | undefined): string | undefined {
  if (!host || !/^[a-z0-9.-]+(?::443)?$/iu.test(host)) {
    return undefined;
  }
  return host.toLowerCase().replace(/:443$/u, "");
}
