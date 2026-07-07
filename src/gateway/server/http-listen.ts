// Gateway HTTP server listen helper with retry and lock-aware errors.
// Phase 8: deferred startup — serves /health immediately during background init.
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

let gatewayReady = false;

/** Register early health-check handler that returns 503 until gateway is fully ready. */
export function registerEarlyHealthHandler(httpServer: HttpServer): void {
  const earlyHandler = (_req: IncomingMessage, res: ServerResponse) => {
    if (gatewayReady) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ready: true }));
    } else {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "starting", ready: false }));
    }
  };
  httpServer.on("request", (req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      earlyHandler(req, res);
    }
  });
}

/** Mark the gateway as fully ready (called after config load + plugin init). */
export function markGatewayReady(): void {
  gatewayReady = true;
}

const EADDRINUSE_MAX_RETRIES = 20;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;

async function closeServerQuietly(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Listen on the configured gateway host/port, retrying transient EADDRINUSE windows. */
export async function listenGatewayHttpServer(params: {
  httpServer: HttpServer;
  bindHost: string;
  port: number;
}) {
  const { httpServer, bindHost, port } = params;

  for (const attempt of Array.from({ length: EADDRINUSE_MAX_RETRIES + 1 }, (_, index) => index)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, bindHost);
      });
      return; // bound successfully
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
        // Port may still be in TIME_WAIT after a recent process exit; retry.
        await closeServerQuietly(httpServer);
        await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
        continue;
      }
      if (code === "EADDRINUSE") {
        throw new GatewayLockError(
          `another gateway instance is already listening on ws://${bindHost}:${port}`,
          err,
        );
      }
      throw new GatewayLockError(
        `failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`,
        err,
      );
    }
  }
}
