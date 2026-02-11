import type { HealthSummary } from "../commands/health.js";
import type { GatewayStuckDetectionConfig } from "../config/types.gateway.js";
import type { ChatRunEntry, ChatRunRegistry } from "./server-chat.js";
import type { DedupeEntry } from "./server-shared.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";

const DEFAULT_STUCK_THRESHOLD_MINUTES = 5;

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  logHealth: { error: (msg: string) => void };
  logStuck?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunRegistry: ChatRunRegistry;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  stuckDetection?: GatewayStuckDetectionConfig;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
} {
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    params.broadcast("tick", payload, { dropIfSlow: true });
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: true })
      .catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: true })
    .catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of params.dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const entries = [...params.dedupe.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < params.dedupe.size - DEDUPE_MAX; i++) {
        params.dedupe.delete(entries[i][0]);
      }
    }

    for (const [runId, entry] of params.chatAbortControllers) {
      if (now <= entry.expiresAtMs) {
        continue;
      }
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunBuffers: params.chatRunBuffers,
          chatDeltaSentAt: params.chatDeltaSentAt,
          chatAbortedRuns: params.chatRunState.abortedRuns,
          removeChatRun: params.removeChatRun,
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          nodeSendToSession: params.nodeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "timeout" },
      );
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
      if (now - abortedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunBuffers.delete(runId);
      params.chatDeltaSentAt.delete(runId);
    }

    // Stuck run detection
    const stuckConfig = params.stuckDetection;
    if (stuckConfig?.enabled !== false) {
      const thresholdMs =
        (stuckConfig?.thresholdMinutes ?? DEFAULT_STUCK_THRESHOLD_MINUTES) * 60 * 1000;
      const action = stuckConfig?.action ?? "log";

      for (const [sessionId, entries] of params.chatRunRegistry.entries()) {
        for (const entry of entries) {
          const elapsed = now - entry.startedAt;
          if (elapsed > thresholdMs) {
            const elapsedMin = Math.round(elapsed / 60_000);
            const meta = {
              sessionId,
              sessionKey: entry.sessionKey,
              clientRunId: entry.clientRunId,
              elapsedMinutes: elapsedMin,
            };

            if (action === "log" || action === "notify") {
              params.logStuck?.warn(
                `Stuck run detected: ${entry.clientRunId} (${elapsedMin}m)`,
                meta,
              );
            }

            if (action === "abort") {
              params.logStuck?.warn(
                `Aborting stuck run: ${entry.clientRunId} (${elapsedMin}m)`,
                meta,
              );
              abortChatRunById(
                {
                  chatAbortControllers: params.chatAbortControllers,
                  chatRunBuffers: params.chatRunBuffers,
                  chatDeltaSentAt: params.chatDeltaSentAt,
                  chatAbortedRuns: params.chatRunState.abortedRuns,
                  removeChatRun: params.removeChatRun,
                  agentRunSeq: params.agentRunSeq,
                  broadcast: params.broadcast,
                  nodeSendToSession: params.nodeSendToSession,
                },
                { runId: entry.clientRunId, sessionKey: entry.sessionKey, stopReason: "stuck" },
              );
            }
          }
        }
      }
    }
  }, 60_000);

  return { tickInterval, healthInterval, dedupeCleanup };
}
