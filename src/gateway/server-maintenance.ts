// Gateway maintenance timers.
// Starts periodic health, dedupe, abort, and media cleanup loops.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../agents/agent-run-terminal-outcome.js";
import { isActiveEmbeddedRunId } from "../agents/embedded-agent-runner/runs.js";
import { formatWorktreeGcResult } from "../agents/worktrees/gc-result.js";
import { createManagedWorktreeOwnerPolicy } from "../agents/worktrees/owner-protection.js";
import {
  managedWorktrees,
  resolveWorktreeCleanupLimits,
  WORKTREE_GC_INTERVAL_MS,
} from "../agents/worktrees/service.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAgentRunContextExecutionOwner,
  sweepStaleRunContexts,
} from "../infra/agent-run-registry.js";
import {
  captureDeliveryQueueStateContext,
  pruneExpiredDeliveryQueueTombstones,
} from "../infra/delivery-queue-sqlite.js";
import { pruneExpiredDevicePairSetupCompletions } from "../infra/device-bootstrap.js";
import { formatErrorMessage as formatError } from "../infra/errors.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "../infra/gateway-active-work.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { pruneOrphanedDeliveryQueueMedia } from "../infra/outbound/delivery-queue-media-spool.js";
import { generateSecureInt } from "../infra/secure-random.js";
import { checkTelemetryUpdate } from "../infra/telemetry.js";
import { cleanOldMedia, pruneOutboundMedia, prunePlaybackTranscodeCache } from "../media/store.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayWorkAdmissionClosed,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createLazyPromiseLoader } from "../shared/lazy-promise.js";
import { registerSkillUsageTracking } from "../skills/workshop/curator.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type { QueuedChatTurnMap } from "./chat-queued-turns.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import type { HealthSummary } from "./health/types.js";
import {
  createHostThawRecovery,
  type HostThawChannelRestartOutcome,
} from "./host-thaw-recovery.js";
import { chatAbortMarkerTimestampMs } from "./server-chat-state.js";
import type { ChatRunState } from "./server-chat-state.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import {
  MEDIA_CLEANUP_STOP_TIMEOUT_MS,
  type MediaCleanupStopResult,
  registerMediaCleanupDrain,
  waitForMediaCleanupDrains,
  waitForMediaCleanupDrainsToSettle,
} from "./server-media-cleanup-lifecycle.js";
import { hasRegisteredChatRunForSessionKey } from "./server-methods/session-active-runs.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "./server-shared.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";
import { startSessionColdStorageMaintenance } from "./session-cold-storage-maintenance.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { checkGatewayInstallationReplacement } from "./stale-install.js";

// Hourly sweep plus a one-day grace bounds orphan storage without racing the
// stage-before-row-commit window.
const DELIVERY_QUEUE_MEDIA_GC_INTERVAL_MS = 60 * 60_000;
const TELEMETRY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export function startGatewayMaintenanceTimers(params: {
  scheduler: GatewayScheduler;
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
  refreshGatewayHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  logHealth: { info: (msg: string) => void; error: (msg: string) => void };
  restartRunningChannels: (
    mode: "new-thaw" | "deferred-retry",
    shouldContinue?: () => boolean,
  ) => Promise<boolean>;
  activeWorkInspectors: Partial<GatewayActiveWorkInspectors>;
  refreshPresence: () => void;
  resetEventLoopHealth: () => void;
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  isNixMode?: boolean;
  getRuntimeConfig: () => OpenClawConfig;
  runWorktreeGc?: () => Promise<ManagedWorktreeGcResult | void>;
  runDeliveryQueueMediaGc?: () => Promise<unknown>;
  runManagedOutgoingMediaGc?: () => Promise<unknown>;
}): {
  stopPeriodicTasks: () => Promise<void>;
  startMediaCleanup: () => void;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  skillUsageCleanup: () => Promise<void>;
} {
  const restartDrainSignal = getGatewayRestartDrainSignal();
  const periodicWork = new AsyncWorkScope();
  let periodicTasksStopPromise: Promise<void> | undefined;
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  const restartChannelsIfIdle = async (
    mode: "new-thaw" | "deferred-retry",
  ): Promise<HostThawChannelRestartOutcome> => {
    const snapshot = createGatewayActiveWorkSnapshot(params.activeWorkInspectors, {
      ignoreTerminalSessions: true,
    });
    if (!snapshot.idle) {
      return { status: "retry", reason: "active-work" };
    }
    // Inspection and admission commit are synchronous: no new work can enter
    // between them, and a busy tick never changes the admission phase.
    let invalidated = false;
    const admission = tryBeginGatewaySuspendAdmission(() => {
      invalidated = true;
    });
    if (!admission) {
      return { status: "retry", reason: "admission-closed" };
    }
    if (!admission.commit()) {
      return { status: "retry", reason: "admission-closed" };
    }
    try {
      const restarted = await params.restartRunningChannels(
        mode,
        () => !invalidated && !periodicTasksStopPromise,
      );
      return restarted
        ? { status: "completed" }
        : { status: "retry", reason: "channel-restart-incomplete" };
    } finally {
      admission.release();
    }
  };

  const hostThawRecovery = createHostThawRecovery({
    nowMs: Date.now,
    restartChannelsIfIdle,
    refreshHealth: async () => {
      await params.refreshGatewayHealthSnapshot({ probe: true });
    },
    refreshPresence: params.refreshPresence,
    resetEventLoopHealth: params.resetEventLoopHealth,
    isAdmissionClosed: () => Boolean(periodicTasksStopPromise) || isGatewayWorkAdmissionClosed(),
    logger: params.logHealth,
  });

  let nextTelemetryCheckAtMs = Date.now() + generateSecureInt(TELEMETRY_MAINTENANCE_INTERVAL_MS);
  let telemetryCheckInFlight: Promise<void> | undefined;
  const performTelemetryCheck = () => {
    telemetryCheckInFlight ??= periodicWork
      .track(() => checkTelemetryUpdate(params.getRuntimeConfig, { surface: "gateway" }))
      .then(() => undefined)
      .catch(() => {})
      .finally(() => {
        telemetryCheckInFlight = undefined;
      });
  };
  // periodic keepalive
  const tickInterval = setInterval(() => {
    void periodicWork
      .track(checkGatewayInstallationReplacement)
      .catch((error: unknown) =>
        params.logHealth.error(`installation check failed: ${formatError(error)}`),
      );
    void periodicWork
      .track(() => hostThawRecovery.tick())
      .catch((error: unknown) =>
        params.logHealth.error(`host thaw recovery failed: ${formatError(error)}`),
      );
    const now = Date.now();
    if (!params.isNixMode && now >= nextTelemetryCheckAtMs) {
      nextTelemetryCheckAtMs =
        now +
        TELEMETRY_MAINTENANCE_INTERVAL_MS +
        generateSecureInt(TELEMETRY_MAINTENANCE_INTERVAL_MS);
      performTelemetryCheck();
    }
    const payload = { ts: now };
    params.broadcast("tick", payload);
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // Keep cached health warm without request-time live channel probes. Explicit
  // status/doctor probe paths still pass probe=true when the operator asks.
  const healthInterval = setInterval(() => {
    void periodicWork
      .track(() => params.refreshGatewayHealthSnapshot({ probe: false }))
      .catch((err: unknown) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  if (!restartDrainSignal.aborted) {
    void periodicWork
      .track(() => params.refreshGatewayHealthSnapshot({ probe: false }))
      .catch((err: unknown) =>
        params.logHealth.error(`initial refresh failed: ${formatError(err)}`),
      );
  }

  const runWorktreeGc =
    params.runWorktreeGc ??
    (() => {
      const cfg = params.getRuntimeConfig();
      return managedWorktrees.gc({
        // Chat runs avoid registry acquire/bump writes; recent session metadata substitutes for
        // worktree activity so idle GC cannot remove a checkout still used by the session.
        ...createManagedWorktreeOwnerPolicy(cfg),
        limits: resolveWorktreeCleanupLimits(),
      });
    });
  let worktreeGcInFlight: Promise<void> | undefined;
  const performWorktreeGc = () =>
    (worktreeGcInFlight ??= periodicWork
      .track(runWorktreeGc)
      .then((result) => {
        if (!result) {
          return;
        }
        if (result.outcome === "partial") {
          params.logHealth.error(formatWorktreeGcResult(result));
        } else if (result.outcome === "deferred") {
          params.logHealth.info(formatWorktreeGcResult(result));
        }
      })
      .catch((err: unknown) => {
        params.logHealth.error(`managed worktree cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        worktreeGcInFlight = undefined;
      }));
  // Retention is hourly best-effort work; leave the first hour free for Gateway warmup.
  const worktreeCleanup = setInterval(() => void performWorktreeGc(), WORKTREE_GC_INTERVAL_MS);

  // Queue tombstone expiry and reference-aware media GC share one maintenance
  // cycle even when the general media TTL sweep is disabled.
  let mediaCleanupStopped = false;
  const createMediaCleanupLoader = (label: string, run: () => Promise<unknown>) => {
    const loader = createLazyPromiseLoader(async () => {
      try {
        await run();
      } catch (error) {
        params.logHealth.error(`${label} failed: ${formatError(error)}`);
      } finally {
        loader.clear();
      }
    });
    return loader;
  };
  const runDeliveryQueueMediaGc =
    params.runDeliveryQueueMediaGc ??
    (async () => {
      const context = captureDeliveryQueueStateContext();
      try {
        await pruneExpiredDeliveryQueueTombstones(undefined, context);
      } finally {
        await pruneOrphanedDeliveryQueueMedia(undefined, context);
      }
    });
  let deliveryQueueMediaGcStartedAtMs = 0;
  const deliveryQueueMediaGcLoader = createMediaCleanupLoader(
    "delivery queue maintenance",
    runDeliveryQueueMediaGc,
  );
  let deliveryQueueMediaGcStartPromise: Promise<void> | undefined;
  const performDeliveryQueueMediaGc = () => {
    if (mediaCleanupStopped) {
      return undefined;
    }
    const running = deliveryQueueMediaGcLoader.peek();
    if (running) {
      return running;
    }
    deliveryQueueMediaGcStartPromise ??= waitForMediaCleanupDrainsToSettle().then(() => {
      deliveryQueueMediaGcStartPromise = undefined;
      if (mediaCleanupStopped) {
        return undefined;
      }
      deliveryQueueMediaGcStartedAtMs = Date.now();
      return deliveryQueueMediaGcLoader.load();
    });
    return deliveryQueueMediaGcStartPromise;
  };
  void performDeliveryQueueMediaGc();

  let devicePairSetupCompletionGcInFlight: Promise<void> | null = null;
  const performDevicePairSetupCompletionGc = (nowMs: number) => {
    if (devicePairSetupCompletionGcInFlight) {
      return devicePairSetupCompletionGcInFlight;
    }
    devicePairSetupCompletionGcInFlight = periodicWork
      .track(() => pruneExpiredDevicePairSetupCompletions({ nowMs }))
      .then(() => undefined)
      .catch((error: unknown) => {
        params.logHealth.error(`device pair setup cleanup failed: ${formatError(error)}`);
      })
      .finally(() => {
        devicePairSetupCompletionGcInFlight = null;
      });
    return devicePairSetupCompletionGcInFlight;
  };
  if (!restartDrainSignal.aborted) {
    void performDevicePairSetupCompletionGc(Date.now());
  }

  const skillUsageCleanup = registerSkillUsageTracking();

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    params.chatRunState.toolEventRecipients.pruneExpired(now);
    void performDevicePairSetupCompletionGc(now);
    if (now - deliveryQueueMediaGcStartedAtMs >= DELIVERY_QUEUE_MEDIA_GC_INTERVAL_MS) {
      void performDeliveryQueueMediaGc();
    }
    const resolveDedupeRunId = (key: string, entry: DedupeEntry) => {
      if (!key.startsWith("agent:") && !key.startsWith("chat:")) {
        return undefined;
      }
      const keyRunId = key.slice(key.indexOf(":") + 1);
      if (keyRunId) {
        if (params.chatAbortControllers.has(keyRunId) || params.chatQueuedTurns.has(keyRunId)) {
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
    const isPendingAcceptedRunDedupeKey = (key: string, dedupeEntry: DedupeEntry) => {
      if (!key.startsWith("agent:") && !key.startsWith(PENDING_CHAT_SEND_DEDUPE_PREFIX)) {
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
      const isAgentKey = key.startsWith("agent:");
      const isChatKey = key.startsWith("chat:");
      if (!isAgentKey && !isChatKey) {
        return false;
      }
      const runId = resolveDedupeRunId(key, dedupeEntry);
      const entry = runId ? params.chatAbortControllers.get(runId) : undefined;
      if (entry) {
        return isAgentKey ? entry.kind === "agent" : entry.kind !== "agent";
      }
      return Boolean(isChatKey && runId && params.chatQueuedTurns.has(runId));
    };
    for (const [k, v] of params.dedupe) {
      if (isActiveRunDedupeKey(k, v) || isPendingAcceptedRunDedupeKey(k, v)) {
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
            !isActiveRunDedupeKey(key, entry) && !isPendingAcceptedRunDedupeKey(key, entry),
        )
        .toSorted(([, left], [, right]) => left.ts - right.ts)
        .slice(0, excess)
        .map(([key]) => key);
      for (const key of oldestKeys) {
        params.dedupe.delete(key);
      }
    }

    pruneMapToMaxSize(params.agentRunSeq, AGENT_RUN_SEQ_MAX);

    for (const [runId, entry] of params.chatAbortControllers) {
      // A stamped terminal observation whose async projection clear never ran
      // (dropped claim, swallowed handler error) would otherwise pin the entry
      // forever: phantom active run in sessions.list, pinned dedupe key,
      // skipped media GC. Past the grace window the entry re-enters the
      // ordinary expiry branches below, which are terminal-safe.
      const terminalClearOverdue =
        typeof entry.projectSessionTerminalObservedAt === "number" &&
        now - entry.projectSessionTerminalObservedAt > AGENT_RUN_TERMINAL_RETRY_GRACE_MS;
      if (entry.projectSessionTerminalPending === true && !terminalClearOverdue) {
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
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
        continue;
      }
      if (entry.projectSessionActive === false) {
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
        continue;
      }
      const aborted = abortChatRunById(params, {
        runId,
        sessionKey: entry.sessionKey,
        stopReason: "timeout",
      });
      // A non-abortable expired entry (signal already aborted, frozen reply
      // op) whose owner cleanup was lost would otherwise survive every sweep:
      // phantom active run, dead Stop button, pinned dedupe, skipped media GC.
      if (!aborted.aborted) {
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      }
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    // Prune expired control-plane rate-limit buckets to prevent unbounded
    // growth when many unique clients connect over time.
    pruneStaleControlPlaneBuckets(now);

    // Idle execution and queued delivery retain their projection until their owners settle.
    for (const [runId, record] of params.chatRunState.runs) {
      if (
        params.chatAbortControllers.has(runId) ||
        params.chatQueuedTurns.has(runId) ||
        hasAgentRunContextExecutionOwner(runId) ||
        isActiveEmbeddedRunId(runId)
      ) {
        continue;
      }
      if (record.abortMarker !== undefined) {
        if (now - chatAbortMarkerTimestampMs(record.abortMarker) > ABORTED_RUN_TTL_MS) {
          params.chatRunState.deleteAbortMarker(runId);
          params.chatRunState.clearRun(runId);
        }
        continue;
      }
      if (now - record.lastActivityAt > ABORTED_RUN_TTL_MS) {
        params.chatRunState.clearRun(runId);
      }
    }
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed).
    sweepStaleRunContexts();
  }, 60_000);

  const playbackTranscodeCacheCleanupLoader = createMediaCleanupLoader(
    "playback transcode cache cleanup",
    prunePlaybackTranscodeCache,
  );
  const runManagedOutgoingMediaGc =
    params.runManagedOutgoingMediaGc ??
    (async () => {
      const { cleanupManagedOutgoingMediaRecords } = await import("./managed-image-attachments.js");
      return await cleanupManagedOutgoingMediaRecords({
        hasActiveSessionRun: (sessionKey, agentId) => {
          const cfg = params.getRuntimeConfig();
          return hasRegisteredChatRunForSessionKey({
            context: { chatAbortControllers: params.chatAbortControllers },
            sessionKey,
            agentId,
            defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey),
          });
        },
      });
    });
  const managedOutgoingCleanupLoader = createMediaCleanupLoader(
    "managed outgoing media cleanup",
    runManagedOutgoingMediaGc,
  );

  let mediaCleanupInFlight: Promise<void> | null = null;
  const runMediaCleanup = () => {
    if (mediaCleanupInFlight) {
      return mediaCleanupInFlight;
    }
    const ttlHours = params.getRuntimeConfig().attachments?.ttlHours;
    const cleanup =
      ttlHours !== undefined
        ? cleanOldMedia(ttlHours * 60 * 60_000, { recursive: true, pruneEmptyDirs: true })
        : pruneOutboundMedia();
    mediaCleanupInFlight = cleanup
      .catch((err: unknown) => {
        params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        mediaCleanupInFlight = null;
      });
    return mediaCleanupInFlight;
  };

  let mediaCleanupInterval: ReturnType<typeof setInterval> | undefined;
  const runMediaMaintenance = () => {
    if (mediaCleanupStopped) {
      return;
    }
    // Playback and managed outgoing have independent owner lifecycles and must
    // not depend on the selected general-or-outbound media sweep being healthy.
    void playbackTranscodeCacheCleanupLoader.load();
    void managedOutgoingCleanupLoader.load();
    void runMediaCleanup();
  };
  let mediaCleanupStartPromise: Promise<void> | undefined;
  const startMediaCleanup = () => {
    if (mediaCleanupStopped || mediaCleanupInterval || mediaCleanupStartPromise) {
      return;
    }
    // Gateway readiness must not wait on a prior stuck generation. Defer only
    // this cleanup owner until the process-wide drain fence is clear.
    mediaCleanupStartPromise = waitForMediaCleanupDrainsToSettle().then(() => {
      mediaCleanupStartPromise = undefined;
      if (mediaCleanupStopped || mediaCleanupInterval) {
        return;
      }
      mediaCleanupInterval = setInterval(runMediaMaintenance, 60 * 60_000);
      runMediaMaintenance();
    });
  };
  let stopMediaCleanupPromise: Promise<MediaCleanupStopResult> | undefined;
  const stopMediaCleanup = () => {
    stopMediaCleanupPromise ??= (async () => {
      mediaCleanupStopped = true;
      if (mediaCleanupInterval) {
        clearInterval(mediaCleanupInterval);
        mediaCleanupInterval = undefined;
      }
      const pending = [
        deliveryQueueMediaGcLoader.peek(),
        playbackTranscodeCacheCleanupLoader.peek(),
        managedOutgoingCleanupLoader.peek(),
        mediaCleanupInFlight,
      ].filter((promise): promise is Promise<void> => promise !== undefined && promise !== null);
      if (pending.length > 0) {
        registerMediaCleanupDrain(Promise.allSettled(pending).then(() => undefined));
      }
      return await waitForMediaCleanupDrains({
        timeoutMs: MEDIA_CLEANUP_STOP_TIMEOUT_MS,
        onTimeout: () => {
          params.logHealth.error(
            `media cleanup drain exceeded ${MEDIA_CLEANUP_STOP_TIMEOUT_MS}ms; retaining shared state until cleanup settles`,
          );
        },
      });
    })();
    return stopMediaCleanupPromise;
  };

  const sessionColdStorageMaintenance = startSessionColdStorageMaintenance({
    scheduler: params.scheduler,
    getRuntimeConfig: params.getRuntimeConfig,
    onError: (message) => params.logHealth.error(`transcript cold storage failed: ${message}`),
  });

  const stopPeriodicTasks = () => {
    if (!periodicTasksStopPromise) {
      restartDrainSignal.removeEventListener("abort", onRestartDrain);
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
      clearInterval(worktreeCleanup);
      periodicTasksStopPromise = Promise.allSettled([
        // Retire producers first, then let admitted callbacks and their cleanup
        // finish before closing their scope or aborting its cancellation signal.
        AsyncWorkScope.runWhenAllIdle(
          () => [periodicWork],
          () => periodicWork.drain(),
        ),
        sessionColdStorageMaintenance.stop(),
        stopMediaCleanup(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Gateway periodic maintenance failed to stop");
        }
      });
      // Drain starts before shutdown joins; retain failures for its warning report.
      void periodicTasksStopPromise.catch(() => {});
    }
    return periodicTasksStopPromise;
  };
  const onRestartDrain = () => {
    void stopPeriodicTasks();
  };
  restartDrainSignal.addEventListener("abort", onRestartDrain, { once: true });
  if (restartDrainSignal.aborted) {
    onRestartDrain();
  }

  return {
    stopPeriodicTasks,
    startMediaCleanup,
    stopMediaCleanup,
    skillUsageCleanup,
  };
}
