import type { HealthSummary } from "../commands/health.js";
import type { ChatRunEntry } from "./server-chat.js";
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
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  memoryInterval: ReturnType<typeof setInterval>;
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

    // Resource limits: cap unbounded maps to prevent memory leaks.
    const AGENT_RUN_SEQ_MAX = 2000;
    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      const keys = params.agentRunSeq.keys();
      for (let i = 0; i < excess; i++) {
        const { value, done } = keys.next();
        if (done) {
          break;
        }
        params.agentRunSeq.delete(value);
      }
    }

    const CHAT_BUFFERS_MAX = 500;
    if (params.chatRunBuffers.size > CHAT_BUFFERS_MAX) {
      const excess = params.chatRunBuffers.size - CHAT_BUFFERS_MAX;
      const keys = params.chatRunBuffers.keys();
      for (let i = 0; i < excess; i++) {
        const { value, done } = keys.next();
        if (done) {
          break;
        }
        params.chatRunBuffers.delete(value);
        params.chatDeltaSentAt.delete(value);
      }
    }
  }, 60_000);

  // Memory monitoring: check heap usage every 60s.
  const MEMORY_WARN_RATIO = 0.7;
  const MEMORY_GC_RATIO = 0.85;
  const MEMORY_CRITICAL_RATIO = 0.95;
  const memoryInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);

    if (heapRatio >= MEMORY_CRITICAL_RATIO) {
      params.logHealth.error(
        `CRITICAL: heap at ${Math.round(heapRatio * 100)}% (${heapUsedMb}/${heapTotalMb}MB, RSS ${rssMb}MB) — requesting graceful restart`,
      );
      // Trigger graceful restart via SIGUSR1 if a listener exists.
      if (process.listenerCount("SIGUSR1") > 0) {
        process.emit("SIGUSR1");
      }
    } else if (heapRatio >= MEMORY_GC_RATIO) {
      params.logHealth.error(
        `heap at ${Math.round(heapRatio * 100)}% (${heapUsedMb}/${heapTotalMb}MB, RSS ${rssMb}MB) — triggering GC`,
      );
      if (global.gc) {
        global.gc();
      }
    } else if (heapRatio >= MEMORY_WARN_RATIO) {
      params.logHealth.error(
        `heap at ${Math.round(heapRatio * 100)}% (${heapUsedMb}/${heapTotalMb}MB, RSS ${rssMb}MB)`,
      );
    }
  }, HEALTH_REFRESH_INTERVAL_MS);

  return { tickInterval, healthInterval, dedupeCleanup, memoryInterval };
}
