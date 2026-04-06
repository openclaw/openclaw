import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  createInternalHookEvent,
  triggerInternalHook,
  type GatewayRestartOutboxTask,
} from "../hooks/internal-hooks.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import {
  formatDoctorNonInteractiveHint,
  readRestartSentinel,
  writeRestartSentinel,
} from "../infra/restart-sentinel.js";
import type { RestartOutboxTask, RestartSentinelPayload } from "../infra/restart-sentinel.js";
import type { PluginServicesHandle } from "../plugins/services.js";

const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 1500;
const GATEWAY_WSS_CLOSE_TIMEOUT_MS = 2000;

type GatewayCloseOptions = {
  reason?: string;
  restartExpectedMs?: number | null;
  /** Best-effort initiator/source (e.g. SIGUSR1, SIGTERM). */
  initiator?: string;
  /** Stable restart identifier for lifecycle correlation. */
  restartId?: string;
  /** Correlation identifier (alias of restartId by default). */
  correlationId?: string;
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function closeWssWithTimeout(
  closeFn: (cb: () => void) => void,
  timeoutMs: number,
): Promise<"closed" | "timeout"> {
  return await new Promise<"closed" | "timeout">((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve("timeout");
    }, timeoutMs);

    closeFn(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve("closed");
    });
  });
}

function normalizeGatewayOutbox(
  outbox: GatewayRestartOutboxTask[],
  restartId?: string,
  correlationId?: string,
): RestartOutboxTask[] {
  return outbox
    .map((raw) => {
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const message = normalizeNonEmptyString(raw.message);
      if (!message) {
        return null;
      }
      const sessionKey = normalizeNonEmptyString(raw.sessionKey);
      const threadId = normalizeNonEmptyString(raw.threadId);
      const deliveryContext = raw.deliveryContext;
      const delivery =
        deliveryContext && typeof deliveryContext === "object"
          ? {
              channel: normalizeNonEmptyString(deliveryContext.channel),
              to: normalizeNonEmptyString(deliveryContext.to),
              accountId: normalizeNonEmptyString(deliveryContext.accountId),
            }
          : undefined;
      const resolvedRestartId = normalizeNonEmptyString(raw.restartId) ?? restartId;
      const resolvedCorrelationId =
        normalizeNonEmptyString(raw.correlationId) ?? correlationId ?? resolvedRestartId;
      const rawKind = normalizeNonEmptyString((raw as { kind?: unknown }).kind);
      const kind: RestartOutboxTask["kind"] =
        rawKind === "system_event" ? "system_event" : "message";
      const task: RestartOutboxTask = {
        ...(kind === "message" ? { kind: "message" as const } : { kind: "system_event" as const }),
        message,
        ...(sessionKey ? { sessionKey } : {}),
        ...(threadId ? { threadId } : {}),
        ...(delivery?.channel || delivery?.to || delivery?.accountId
          ? {
              deliveryContext: {
                ...(delivery.channel ? { channel: delivery.channel } : {}),
                ...(delivery.to ? { to: delivery.to } : {}),
                ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
              },
            }
          : {}),
        ...(resolvedRestartId ? { restartId: resolvedRestartId } : {}),
        ...(resolvedCorrelationId ? { correlationId: resolvedCorrelationId } : {}),
      };
      return task;
    })
    .filter((task): task is RestartOutboxTask => task !== null);
}

async function persistGatewayRestartOutbox(params: {
  reason: string;
  initiator?: string;
  restartId?: string;
  correlationId?: string;
  outbox: GatewayRestartOutboxTask[];
}) {
  const normalizedOutbox = normalizeGatewayOutbox(
    params.outbox,
    params.restartId,
    params.correlationId,
  );

  const existing = await readRestartSentinel().catch(() => null);
  const existingPayload = existing?.payload;
  const existingOutbox = Array.isArray(existingPayload?.outbox) ? existingPayload.outbox : [];
  const mergedOutbox = [...existingOutbox, ...normalizedOutbox];

  if (!existingPayload && mergedOutbox.length === 0) {
    return;
  }

  const resolvedRestartId = params.restartId ?? existingPayload?.restartId;
  const resolvedCorrelationId =
    params.correlationId ?? existingPayload?.correlationId ?? resolvedRestartId;
  const resolvedInitiator = params.initiator ?? existingPayload?.initiator;
  const stats = {
    ...existingPayload?.stats,
    reason: existingPayload?.stats?.reason ?? params.reason,
  };

  const payload: RestartSentinelPayload = {
    kind: existingPayload?.kind ?? "restart",
    status: existingPayload?.status ?? "ok",
    ts: existingPayload?.ts ?? Date.now(),
    ...(resolvedRestartId ? { restartId: resolvedRestartId } : {}),
    ...(resolvedCorrelationId ? { correlationId: resolvedCorrelationId } : {}),
    ...(resolvedInitiator ? { initiator: resolvedInitiator } : {}),
    ...(existingPayload?.sessionKey ? { sessionKey: existingPayload.sessionKey } : {}),
    ...(existingPayload?.deliveryContext
      ? { deliveryContext: existingPayload.deliveryContext }
      : {}),
    ...(existingPayload?.threadId ? { threadId: existingPayload.threadId } : {}),
    ...(typeof existingPayload?.message === "string" || existingPayload?.message === null
      ? { message: existingPayload.message }
      : {}),
    ...(existingPayload?.doctorHint
      ? { doctorHint: existingPayload.doctorHint }
      : { doctorHint: formatDoctorNonInteractiveHint() }),
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
    ...(typeof existingPayload?.suppressPrimaryNotice === "boolean"
      ? { suppressPrimaryNotice: existingPayload.suppressPrimaryNotice }
      : !existingPayload && mergedOutbox.length > 0
        ? { suppressPrimaryNotice: true }
        : {}),
    ...(mergedOutbox.length > 0 ? { outbox: mergedOutbox } : {}),
  };

  await writeRestartSentinel(payload).catch(() => {
    // best-effort only
  });
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  releasePluginRouteRegistry?: (() => void) | null;
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
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  chatRunState: { clear: () => void };
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
}) {
  return async (opts?: GatewayCloseOptions) => {
    try {
      const reasonRaw = typeof opts?.reason === "string" ? opts.reason.trim() : "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      const initiatorRaw = typeof opts?.initiator === "string" ? opts.initiator.trim() : "";
      const initiator = initiatorRaw || undefined;
      const restartId =
        restartExpectedMs !== null
          ? (normalizeNonEmptyString(opts?.restartId) ?? randomUUID())
          : undefined;
      const correlationIdRaw =
        typeof opts?.correlationId === "string" ? opts.correlationId.trim() : "";
      const correlationId = correlationIdRaw || restartId;
      const outbox: GatewayRestartOutboxTask[] = [];

      try {
        const shutdownEvent = createInternalHookEvent("gateway", "shutdown", "gateway", {
          reason,
          restartExpectedMs,
          ...(initiator ? { initiator } : {}),
          ...(restartId ? { restartId } : {}),
          ...(correlationId ? { correlationId } : {}),
          outbox,
        });
        await triggerInternalHook(shutdownEvent, {
          perHandlerTimeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
        });

        if (restartExpectedMs !== null) {
          const preRestartEvent = createInternalHookEvent("gateway", "pre-restart", "gateway", {
            reason,
            restartExpectedMs,
            ...(initiator ? { initiator } : {}),
            ...(restartId ? { restartId } : {}),
            ...(correlationId ? { correlationId } : {}),
            outbox,
          });
          await triggerInternalHook(preRestartEvent, {
            perHandlerTimeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
          });

          await persistGatewayRestartOutbox({
            reason,
            initiator,
            restartId,
            correlationId,
            outbox,
          });
        }
      } catch {
        // Best-effort only; shutdown should proceed even if hooks fail.
      }

      if (params.bonjourStop) {
        try {
          await params.bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (params.tailscaleCleanup) {
        await params.tailscaleCleanup();
      }
      if (params.canvasHost) {
        try {
          await params.canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (params.canvasHostServer) {
        try {
          await params.canvasHostServer.close();
        } catch {
          /* ignore */
        }
      }
      for (const plugin of listChannelPlugins()) {
        await params.stopChannel(plugin.id);
      }
      if (params.pluginServices) {
        await params.pluginServices.stop().catch(() => {});
      }
      await stopGmailWatcher();
      params.cron.stop();
      params.heartbeatRunner.stop();
      try {
        params.updateCheckStop?.();
      } catch {
        /* ignore */
      }
      for (const timer of params.nodePresenceTimers.values()) {
        clearInterval(timer);
      }
      params.nodePresenceTimers.clear();
      params.broadcast("shutdown", {
        reason,
        restartExpectedMs,
        ...(initiator ? { initiator } : {}),
        ...(restartId ? { restartId } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      clearInterval(params.tickInterval);
      clearInterval(params.healthInterval);
      clearInterval(params.dedupeCleanup);
      if (params.mediaCleanup) {
        clearInterval(params.mediaCleanup);
      }
      if (params.agentUnsub) {
        try {
          params.agentUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.heartbeatUnsub) {
        try {
          params.heartbeatUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.transcriptUnsub) {
        try {
          params.transcriptUnsub();
        } catch {
          /* ignore */
        }
      }
      if (params.lifecycleUnsub) {
        try {
          params.lifecycleUnsub();
        } catch {
          /* ignore */
        }
      }
      params.chatRunState.clear();
      for (const c of params.clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      params.clients.clear();
      await params.configReloader.stop().catch(() => {});
      const wssCloseResult = await closeWssWithTimeout(
        (cb) => params.wss.close(() => cb()),
        GATEWAY_WSS_CLOSE_TIMEOUT_MS,
      );
      if (wssCloseResult === "timeout") {
        params.logger?.warn?.(
          `[gateway] websocket server close timed out after ${GATEWAY_WSS_CLOSE_TIMEOUT_MS}ms, continuing shutdown`,
        );
      }
      const servers =
        params.httpServers && params.httpServers.length > 0
          ? params.httpServers
          : [params.httpServer];
      for (const server of servers) {
        const httpServer = server as HttpServer & {
          closeIdleConnections?: () => void;
        };
        if (typeof httpServer.closeIdleConnections === "function") {
          httpServer.closeIdleConnections();
        }
        await new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      try {
        params.releasePluginRouteRegistry?.();
      } catch {
        /* ignore */
      }
    }
  };
}
