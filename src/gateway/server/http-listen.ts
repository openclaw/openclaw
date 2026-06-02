import type { Server as HttpServer } from "node:http";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

const EADDRINUSE_MAX_RETRIES = 20;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;

async function closeServerQuietly(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      // Retrying listen() after EADDRINUSE needs a clean server state even if
      // Node reports the previous bind failure before a listening callback.
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

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
          // Remove the paired listener so a late "listening" event from a failed
          // attempt cannot resolve the next retry's promise.
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          // Symmetric cleanup keeps repeated listen attempts from accumulating
          // stale error handlers on the shared server instance.
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
