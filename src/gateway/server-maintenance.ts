// Gateway maintenance timers.
// Starts periodic health, dedupe, abort, and media cleanup loops.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { HealthSummary } from "../commands/health.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sweepStaleRunContexts } from "../infra/agent-events.js";
import { cleanOldMedia } from "../media/store.js";
import {
  abortTrackedChatRunById,
  type ChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { chatAbortMarkerTimestampMs } from "./server-chat-state.js";
import type { ChatRunState } from "./server-chat-state.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";
import { startDailySessionResetScheduler } from "./session-daily-reset-scheduler.js";
import { loadGatewaySessionRow } from "./session-utils.js";

function broadcastScheduledDailyReset(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  broadcastToConnIds?: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  getSessionEventSubscriberConnIds?: () => ReadonlySet<string>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  sessionKey: string;
  agentId?: string;
  getConfig: () => OpenClawConfig;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  const sessionRow = loadGatewaySessionRow(
    params.sessionKey,
    params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : undefined,
  );
  const payload = {
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: "reset",
    ts: Date.now(),
    ...(sessionRow
      ? {
          updatedAt: sessionRow.updatedAt ?? undefined,
          sessionId: sessionRow.sessionId,
          kind: sessionRow.kind,
          channel: sessionRow.channel,
          subject: sessionRow.subject,
          groupChannel: sessionRow.groupChannel,
          space: sessionRow.space,
          chatType: sessionRow.chatType,
          origin: sessionRow.origin,
          label: sessionRow.label,
          displayName: sessionRow.displayName,
          deliveryContext: sessionRow.deliveryContext,
          parentSessionKey: sessionRow.parentSessionKey,
          sendPolicy: sessionRow.sendPolicy,
          systemSent: sessionRow.systemSent,
          abortedLastRun: sessionRow.abortedLastRun,
          inputTokens: sessionRow.inputTokens,
          outputTokens: sessionRow.outputTokens,
          lastChannel: sessionRow.lastChannel,
          lastTo: sessionRow.lastTo,
          lastAccountId: sessionRow.lastAccountId,
          lastThreadId: sessionRow.lastThreadId,
          totalTokens: sessionRow.totalTokens,
          totalTokensFresh: sessionRow.totalTokensFresh,
          contextTokens: sessionRow.contextTokens,
          responseUsage: sessionRow.responseUsage,
          modelProvider: sessionRow.modelProvider,
          model: sessionRow.model,
          status: sessionRow.status,
          startedAt: sessionRow.startedAt,
          endedAt: sessionRow.endedAt,
          runtimeMs: sessionRow.runtimeMs,
        }
      : {}),
  };
  if (params.broadcastToConnIds && params.getSessionEventSubscriberConnIds) {
    emitSessionsChanged(
      {
        broadcastToConnIds: params.broadcastToConnIds,
        chatAbortControllers: params.chatAbortControllers,
        getRuntimeConfig: params.getConfig,
        getSessionEventSubscriberConnIds: params.getSessionEventSubscriberConnIds,
      },
      {
        sessionKey: params.sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        reason: "reset",
      },
    );
  } else {
    params.broadcast("sessions.changed", payload, { dropIfSlow: true });
  }
  for (const deliverySessionKey of resolveScheduledResetNodeDeliverySessionKeys({
    cfg: params.getConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  })) {
    params.nodeSendToSession(deliverySessionKey, "sessions.changed", payload);
  }
}

function resolveScheduledResetNodeDeliverySessionKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string[] {
  if (params.sessionKey !== "global") {
    return [params.sessionKey];
  }
  const scopedAgentId = params.agentId?.trim();
  if (!scopedAgentId) {
    return [params.sessionKey];
  }
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const keys = [`agent:${scopedAgentId}:global`];
  if (scopedAgentId === defaultAgentId) {
    keys.push(params.sessionKey);
  }
  return keys;
}

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  broadcastToConnIds?: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getSessionEventSubscriberConnIds?: () => ReadonlySet<string>;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  logHealth: { error: (msg: string) => void };
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  chatRunState: Pick<
    ChatRunState,
    | "abortedRuns"
    | "bufferUpdatedAt"
    | "clearRun"
    | "deltaLastBroadcastText"
    | "agentDeltaSentAt"
    | "bufferedAgentEvents"
  >;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  cfg?: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  mediaCleanupTtlMs?: number;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  dailySessionReset: ReturnType<typeof setInterval> | null;
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
    params.broadcast("tick", payload);
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // Keep cached health warm without request-time live channel probes. Explicit
  // status/doctor probe paths still pass probe=true when the operator asks.
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: false })
      .catch((err: unknown) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: false })
    .catch((err: unknown) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    const resolveDedupeRunId = (key: string, entry: DedupeEntry) => {
      if (!key.startsWith("agent:") && !key.startsWith("chat:")) {
        return undefined;
      }
      const keyRunId = key.slice(key.indexOf(":") + 1);
      if (keyRunId) {
        const directEntry = params.chatAbortControllers.get(keyRunId);
        if (directEntry) {
          return keyRunId;
        }
      }
      const payload = entry.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId.trim() || undefined
          : undefined
        : undefined;
    };
    const isPendingAcceptedAgentDedupeKey = (key: string, dedupeEntry: DedupeEntry) => {
      if (!key.startsWith("agent:")) {
        return false;
      }
      const payload = dedupeEntry.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
      }
      if ((payload as { status?: unknown }).status !== "accepted") {
        return false;
      }
      const expiresAtMs = (payload as { expiresAtMs?: unknown }).expiresAtMs;
      return isFutureDateTimestampMs(expiresAtMs, { nowMs: now });
    };
    const isActiveRunDedupeKey = (key: string, dedupeEntry: DedupeEntry) => {
      // Keep idempotency records for active runs so retries cannot create
      // duplicate chat/agent work while a command is still draining.
      if (!key.startsWith("agent:") && !key.startsWith("chat:")) {
        return false;
      }
      const runId = resolveDedupeRunId(key, dedupeEntry);
      const entry = runId ? params.chatAbortControllers.get(runId) : undefined;
      if (!entry) {
        return false;
      }
      return key.startsWith("agent:") ? entry.kind === "agent" : entry.kind !== "agent";
    };
    for (const [k, v] of params.dedupe) {
      if (isActiveRunDedupeKey(k, v) || isPendingAcceptedAgentDedupeKey(k, v)) {
        continue;
      }
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const excess = params.dedupe.size - DEDUPE_MAX;
      const oldestKeys = [...params.dedupe.entries()]
        .filter(
          ([key, entry]) =>
            !isActiveRunDedupeKey(key, entry) && !isPendingAcceptedAgentDedupeKey(key, entry),
        )
        .toSorted(([, left], [, right]) => left.ts - right.ts)
        .slice(0, excess)
        .map(([key]) => key);
      for (const key of oldestKeys) {
        params.dedupe.delete(key);
      }
    }

    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      let removed = 0;
      for (const runId of params.agentRunSeq.keys()) {
        params.agentRunSeq.delete(runId);
        removed += 1;
        if (removed >= excess) {
          break;
        }
      }
    }

    const resolveAgentThrottleRunId = (key: string) => {
      if (key.endsWith(":assistant")) {
        return key.slice(0, -":assistant".length);
      }
      if (key.endsWith(":thinking")) {
        return key.slice(0, -":thinking".length);
      }
      return key;
    };

    for (const [runId, entry] of params.chatAbortControllers) {
      if (entry.projectSessionTerminalPending === true) {
        continue;
      }
      if (isFutureDateTimestampMs(entry.expiresAtMs, { nowMs: now })) {
        continue;
      }
      if (entry.projectSessionTerminalPersistence) {
        const lifecycleGeneration = entry.lifecycleGeneration?.trim();
        const sessionKey = entry.sessionKey.trim();
        const sessionId = entry.sessionId.trim();
        if (entry.controlUiVisible !== false && lifecycleGeneration && sessionKey && sessionId) {
          params.restartRecoveryCandidates.set(runId, {
            runId,
            lifecycleGeneration,
            sessionKey,
            sessionId,
            observedAt: entry.projectSessionTerminalObservedAt,
          });
        }
        params.chatAbortControllers.delete(runId);
        continue;
      }
      if (entry.projectSessionActive === false) {
        params.chatAbortControllers.delete(runId);
        continue;
      }
      abortTrackedChatRunById(params, {
        runId,
        sessionKey: entry.sessionKey,
        stopReason: "timeout",
      });
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortMarker] of params.chatRunState.abortedRuns) {
      if (now - chatAbortMarkerTimestampMs(abortMarker) <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunState.clearRun(runId);
    }

    // Prune expired control-plane rate-limit buckets to prevent unbounded
    // growth when many unique clients connect over time.
    pruneStaleControlPlaneBuckets(now);

    // Sweep stale buffers for runs that were never explicitly aborted.
    // Only reap orphaned buffers after the abort controller is gone; active
    // runs can legitimately sit idle while tools/models work.
    for (const [runId, lastSentAt] of params.chatDeltaSentAt) {
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue; // already handled above
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastSentAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    for (const [runId, lastUpdatedAt] of params.chatRunState.bufferUpdatedAt) {
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue;
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastUpdatedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    for (const [key, lastSentAt] of params.chatRunState.agentDeltaSentAt) {
      const runId = resolveAgentThrottleRunId(key);
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue;
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastSentAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed).
    sweepStaleRunContexts();
  }, 60_000);

  const dailySessionReset =
    params.cfg || params.getConfig
      ? startDailySessionResetScheduler({
          cfg: params.cfg ?? params.getConfig?.() ?? {},
          getConfig: params.getConfig,
          getActiveSessionKeys: () =>
            new Set(
              [...params.chatAbortControllers.values()]
                .map((entry) =>
                  entry.sessionKey === "global" && entry.agentId
                    ? `agent:${entry.agentId}:main`
                    : entry.sessionKey,
                )
                .filter((sessionKey) => sessionKey.trim()),
            ),
          onSuccessfulReset: ({ sessionKey, agentId }) => {
            broadcastScheduledDailyReset({
              broadcast: params.broadcast,
              broadcastToConnIds: params.broadcastToConnIds,
              getSessionEventSubscriberConnIds: params.getSessionEventSubscriberConnIds,
              nodeSendToSession: params.nodeSendToSession,
              sessionKey,
              agentId,
              getConfig: params.getConfig ?? (() => params.cfg ?? {}),
              chatAbortControllers: params.chatAbortControllers,
            });
          },
        })
      : null;

  if (typeof params.mediaCleanupTtlMs !== "number") {
    return { tickInterval, healthInterval, dedupeCleanup, mediaCleanup: null, dailySessionReset };
  }

  let mediaCleanupInFlight: Promise<void> | null = null;
  const runMediaCleanup = () => {
    if (mediaCleanupInFlight) {
      return mediaCleanupInFlight;
    }
    mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
      recursive: true,
      pruneEmptyDirs: true,
    })
      .catch((err: unknown) => {
        params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        mediaCleanupInFlight = null;
      });
    return mediaCleanupInFlight;
  };

  const mediaCleanup = setInterval(() => {
    void runMediaCleanup();
  }, 60 * 60_000);

  void runMediaCleanup();

  return { tickInterval, healthInterval, dedupeCleanup, mediaCleanup, dailySessionReset };
}
