import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginServicesHandle } from "../plugins/services.js";

const log = createSubsystemLogger("gateway/shutdown");

/** Timeout (ms) for the HTTP server close before force-rejecting. */
const HTTP_CLOSE_TIMEOUT_MS = 8_000;

export type ShutdownResult = {
  /** Total wall-clock time of the shutdown sequence in ms. */
  durationMs: number;
  /** Names of subsystems that encountered non-fatal errors during shutdown. */
  warnings: string[];
};

/**
 * Attempt an async shutdown step and track any failure as a warning.
 * Returns `true` if the step succeeded, `false` otherwise.
 */
async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`${name}: ${detail}`);
    warnings.push(name);
    return false;
  }
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  chatRunState: { clear: () => void };
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  browserControl: { stop: () => Promise<void> } | null;
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
}) {
  return async (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
  }): Promise<ShutdownResult> => {
    const start = Date.now();
    const warnings: string[] = [];

    const reasonRaw = typeof opts?.reason === "string" ? opts.reason.trim() : "";
    const reason = reasonRaw || "gateway stopping";
    const restartExpectedMs =
      typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
        ? Math.max(0, Math.floor(opts.restartExpectedMs))
        : null;

    log.info(`shutdown started: ${reason}`);

    // --- Discovery & networking teardown ---
    if (params.bonjourStop) {
      await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
    }
    if (params.tailscaleCleanup) {
      await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
    }

    // --- Canvas ---
    if (params.canvasHost) {
      await shutdownStep("canvas-host", () => params.canvasHost!.close(), warnings);
    }
    if (params.canvasHostServer) {
      await shutdownStep("canvas-host-server", () => params.canvasHostServer!.close(), warnings);
    }

    // --- Channels & plugins ---
    for (const plugin of listChannelPlugins()) {
      await shutdownStep(`channel/${plugin.id}`, () => params.stopChannel(plugin.id), warnings);
    }
    if (params.pluginServices) {
      await shutdownStep("plugin-services", () => params.pluginServices!.stop(), warnings);
    }
    await shutdownStep("gmail-watcher", () => stopGmailWatcher(), warnings);

    // --- Schedulers ---
    params.cron.stop();
    params.heartbeatRunner.stop();
    await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);

    // --- Node presence timers ---
    for (const timer of params.nodePresenceTimers.values()) {
      clearInterval(timer);
    }
    params.nodePresenceTimers.clear();

    // --- Broadcast shutdown event to connected clients ---
    params.broadcast("shutdown", {
      reason,
      restartExpectedMs,
    });

    // --- Clear intervals ---
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);
    if (params.mediaCleanup) {
      clearInterval(params.mediaCleanup);
    }

    // --- Event subscriptions ---
    if (params.agentUnsub) {
      await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
    }
    if (params.heartbeatUnsub) {
      await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
    }

    // --- Client connections ---
    params.chatRunState.clear();
    let clientCloseFailures = 0;
    for (const c of params.clients) {
      try {
        c.socket.close(1012, "service restart");
      } catch {
        clientCloseFailures++;
      }
    }
    if (clientCloseFailures > 0) {
      log.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
      warnings.push("ws-clients");
    }
    params.clients.clear();

    // --- Config & browser ---
    await shutdownStep("config-reloader", () => params.configReloader.stop(), warnings);
    if (params.browserControl) {
      await shutdownStep("browser-control", () => params.browserControl!.stop(), warnings);
    }

    // --- WebSocket server ---
    await new Promise<void>((resolve) => params.wss.close(() => resolve()));

    // --- HTTP server(s) with timeout ---
    const servers =
      params.httpServers && params.httpServers.length > 0
        ? params.httpServers
        : [params.httpServer];
    for (let i = 0; i < servers.length; i++) {
      const httpServer = servers[i] as HttpServer & {
        closeIdleConnections?: () => void;
      };
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      }
      const label = servers.length > 1 ? `http-server[${i}]` : "http-server";
      await shutdownStep(
        label,
        () =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`close timed out after ${HTTP_CLOSE_TIMEOUT_MS}ms`));
            }, HTTP_CLOSE_TIMEOUT_MS);
            httpServer.close((err) => {
              clearTimeout(timer);
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          }),
        warnings,
      );
    }

    const durationMs = Date.now() - start;
    if (warnings.length > 0) {
      log.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
    } else {
      log.info(`shutdown completed cleanly in ${durationMs}ms`);
    }

    return { durationMs, warnings };
  };
}
