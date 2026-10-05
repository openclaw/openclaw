import type { Server as HttpServer } from "node:http";
import { hasErrnoCode } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { settlesWithin } from "../shared/settle-within.js";
import { createCloseStepTimer, shutdownStep } from "./server-close-step.js";
import type { GatewayCloseParams } from "./server-close.js";
import { WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import { clearSessionTypingState } from "./server-methods/session-typing-state.js";
import { recordGatewayShutdownWarning as recordShutdownWarning } from "./server-shutdown.js";
const shutdownLog = createSubsystemLogger("gateway/shutdown");
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5000;

async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  return await settlesWithin(params.closePromise, params.timeoutMs).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${params.label}: ${detail}`);
    recordShutdownWarning(params.warnings, params.label);
    return true;
  });
}

async function closeHttpListener(params: {
  server: HttpServer;
  label: string;
  warnings: string[];
}): Promise<void> {
  const { server, label, warnings } = params;
  server.closeIdleConnections?.();
  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (!err || hasErrnoCode(err, "ERR_SERVER_NOT_RUNNING")) {
        resolve();
        return;
      }
      reject(err);
    });
  });
  void closePromise.catch(() => undefined);
  const closedWithinGrace = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_GRACE_MS,
    label,
    warnings,
  });
  if (closedWithinGrace) {
    return;
  }
  shutdownLog.warn(
    `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
  );
  recordShutdownWarning(warnings, label);
  server.closeAllConnections?.();
  const closedAfterForce = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_FORCE_WAIT_MS,
    label,
    warnings,
  });
  if (!closedAfterForce) {
    throw new Error(
      `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
    );
  }
}

/** Ordinary shutdown and reader expiry share the transport cleanup owner. */
export async function closeGatewayTransports(
  params: Pick<
    GatewayCloseParams,
    "clients" | "wss" | "httpServer" | "httpServers" | "tailscaleCleanup" | "finishRequestEntries"
  >,
  options: { reason: string; warnings: string[]; retainReaderTransport?: true },
): Promise<void> {
  const { warnings } = options;
  const measureCloseStep = createCloseStepTimer(options.reason);
  let clientCloseFailures = 0;
  for (const c of params.clients) {
    if (options.retainReaderTransport && c.connect?.role === "operator") {
      continue;
    }
    try {
      c.socket.close(1012, c.connectionKind === "worker" ? "gateway-shutdown" : "service restart");
    } catch {
      clientCloseFailures++;
    }
  }
  if (clientCloseFailures > 0) {
    shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
    recordShutdownWarning(warnings, "ws-clients");
  }
  if (!options.retainReaderTransport) {
    params.clients.clear();
  }
  if (params.wss && !options.retainReaderTransport) {
    await measureCloseStep("websocket-server", async () => {
      const wsClients = params.wss?.clients ?? new Set();
      const closePromise = new Promise<void>((resolve) => {
        params.wss?.close(() => resolve());
      });
      const closedWithinGrace = await settlesWithin(closePromise, WEBSOCKET_CLOSE_GRACE_MS);
      if (!closedWithinGrace) {
        shutdownLog.warn(
          `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
        );
        recordShutdownWarning(warnings, "websocket-server");
        for (const client of wsClients) {
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
        }
        if (!(await settlesWithin(closePromise, WEBSOCKET_CLOSE_FORCE_CONTINUE_MS))) {
          shutdownLog.warn(
            `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
          );
        }
      }
    });
  }
  // Node cleanup replies remain admissible until sockets close. Join their
  // uncancellable preparation before releasing the remaining process state.
  await params.finishRequestEntries?.();
  clearSessionTypingState();
  const transportServers =
    params.httpServers && params.httpServers.length > 0
      ? params.httpServers
      : params.httpServer
        ? [params.httpServer]
        : [];
  try {
    if (transportServers.length > 0 && !options.retainReaderTransport) {
      await measureCloseStep("http-server", async () => {
        const results = await Promise.allSettled(
          transportServers.map((server, index) =>
            closeHttpListener({
              server,
              label: transportServers.length > 1 ? `http-server[${index}]` : "http-server",
              warnings,
            }),
          ),
        );
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) {
          throw failure.reason;
        }
      });
    }
  } finally {
    // The foreground Tailscale session owns the route, so closing its claim
    // releases the ephemeral backend before this lifecycle is forgotten.
    if (params.tailscaleCleanup && !options.retainReaderTransport) {
      await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
    }
  }
}
