import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isActiveEmbeddedRunId } from "../agents/embedded-agent-runner/runs.js";
import { formatWorktreeGcResult } from "../agents/worktrees/gc-result.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAgentRunContextExecutionOwner,
  sweepStaleRunContexts,
} from "../infra/agent-run-registry.js";
import {
  captureDeliveryQueueStateContext,
  pruneExpiredDeliveryQueueTombstones,
} from "../infra/delivery-queue-sqlite.js";
import { startDevicePairSetupMaintenance } from "../infra/device-bootstrap.js";
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
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { registerSkillUsageTracking } from "../skills/workshop/skill-usage.js";
import { pruneExpiredArtifactDownloads } from "./artifact-download-grants.js";
import type { RestartRecoveryCandidate } from "./chat-abort.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import type { HealthSummary } from "./health/types.js";
import {
  createHostThawRecovery,
  type HostThawChannelRestartOutcome,
} from "./host-thaw-recovery.js";
import {
  chatAbortMarkerTimestampMs,
  type ChatRunEntry,
  type ChatRunState,
} from "./server-chat-state.js";
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
import type { GatewayClient, GatewayContextResolver } from "./server-methods/types.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "./server-shared.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";
import { startSessionColdStorageMaintenance } from "./session-cold-storage-maintenance.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";
import { checkGatewayInstallationReplacement } from "./stale-install.js";
import { startWorktreeMaintenance } from "./worktree-maintenance.js";

// Hourly sweep plus a one-day grace bounds orphan storage without racing the
// stage-before-row-commit window.
const DELIVERY_QUEUE_MEDIA_GC_INTERVAL_MS = 60 * 60_000;
// Maintenance phases can run 10s early; keep cleanup beyond the two-minute reconnect wave.
const MEDIA_CLEANUP_STARTUP_DELAY_MS = 130_000;
const TELEMETRY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export function startGatewayMaintenanceTimers(params: {
  scheduler: GatewayScheduler;
  resolveGatewayContext?: GatewayContextResolver;
  clients: ReadonlySet<GatewayClient>;
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
  const matchesGateway = captureGatewayScopeMatcher(params.resolveGatewayContext);
  const restartDrainSignal = getGatewayRestartDrainSignal();
  const scheduler = params.scheduler.scope();
  const schedulePeriodic = (
    id: string,
    everyMs: number,
    run: () => void | Promise<unknown>,
    immediate = false,
  ) => {
    scheduler.schedule({
      id: `maintenance:${id}`,
      atMs: scheduler.now() + (immediate ? 0 : everyMs),
      everyMs,
      phase: "maintenance",
      run,
    });
  };
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
    const admission = tryBeginGatewaySuspendAdmission(
      () => {
        invalidated = true;
      },
      {
        owner: "host-thaw-recovery",
        leaseId: `host-thaw-${scheduler.now()}`,
        caller: "maintenance:host-thaw",
        reason: mode,
      },
    );
    if (!admission?.commit()) {
      return { status: "retry", reason: "admission-closed" };
    }
    try {
      const restarted = await params.restartRunningChannels(
        mode,
        () => !invalidated && !scheduler.signal.aborted,
      );
      return restarted
        ? { status: "completed" }
        : { status: "retry", reason: "channel-restart-incomplete" };
    } finally {
      admission.release();
    }
  };

  const hostThawRecovery = createHostThawRecovery({
    nowMs: () => scheduler.now(),
    restartChannelsIfIdle,
    refreshHealth: async () => {
      await params.refreshGatewayHealthSnapshot({ probe: true });
    },
    refreshPresence: params.refreshPresence,
    resetEventLoopHealth: params.resetEventLoopHealth,
    isAdmissionClosed: () => scheduler.signal.aborted || isGatewayWorkAdmissionClosed(),
    logger: params.logHealth,
  });

  const scheduleTelemetry = (delayMs: number) => {
    scheduler.schedule({
      id: "maintenance:telemetry",
      delayMs,
      run: async () => {
        try {
          await checkTelemetryUpdate(params.getRuntimeConfig, { surface: "gateway" });
        } catch {
          // Telemetry retries on its next jittered maintenance deadline.
        } finally {
          if (!scheduler.signal.aborted) {
            scheduleTelemetry(
              TELEMETRY_MAINTENANCE_INTERVAL_MS +
                generateSecureInt(TELEMETRY_MAINTENANCE_INTERVAL_MS),
            );
          }
        }
      },
    });
  };
  if (!params.isNixMode) {
    scheduleTelemetry(generateSecureInt(TELEMETRY_MAINTENANCE_INTERVAL_MS));
  }
  schedulePeriodic("installation", TICK_INTERVAL_MS, () =>
    checkGatewayInstallationReplacement().catch((error: unknown) =>
      params.logHealth.error(`installation check failed: ${formatError(error)}`),
    ),
  );
  schedulePeriodic("host-thaw", TICK_INTERVAL_MS, () =>
    hostThawRecovery
      .tick()
      .catch((error: unknown) =>
        params.logHealth.error(`host thaw recovery failed: ${formatError(error)}`),
      ),
  );
  schedulePeriodic("tick", TICK_INTERVAL_MS, () => {
    const payload = { ts: scheduler.now() };
    params.broadcast("tick", payload);
    params.nodeSendToAllSubscribed("tick", payload);
  });

  // Warm once; an unobserved Gateway needs no periodic snapshot. Health requests
  // refresh stale snapshots, and connected clients still receive passive updates.
  let initialHealthRefresh = true;
  schedulePeriodic(
    "health",
    HEALTH_REFRESH_INTERVAL_MS,
    () => {
      if (!initialHealthRefresh && params.clients.size === 0) {
        return undefined;
      }
      initialHealthRefresh = false;
      return params
        .refreshGatewayHealthSnapshot({ probe: false })
        .catch((err: unknown) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
    },
    true,
  );

  const worktreeMaintenance = startWorktreeMaintenance({
    scheduler: params.scheduler,
    getRuntimeConfig: params.getRuntimeConfig,
    runGc: params.runWorktreeGc,
    onComplete: (result) => {
      const message = formatWorktreeGcResult(result);
      if (result.outcome === "partial") {
        params.logHealth.error(message);
      } else {
        params.logHealth.info(message);
      }
    },
    onError: (message) => params.logHealth.error(`managed worktree cleanup failed: ${message}`),
  });

  // Queue tombstone expiry and reference-aware media GC share one maintenance
  // cycle even when the general media TTL sweep is disabled.
  const mediaScheduler = params.scheduler.scope();
  const mediaCleanupAtMs = mediaScheduler.now() + MEDIA_CLEANUP_STARTUP_DELAY_MS;
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
  const scheduleMedia = (id: string, run: () => Promise<unknown>) => {
    mediaScheduler.schedule({
      id: `maintenance:${id}`,
      atMs: mediaCleanupAtMs,
      everyMs: DELIVERY_QUEUE_MEDIA_GC_INTERVAL_MS,
      phase: "maintenance",
      run,
    });
  };
  void waitForMediaCleanupDrainsToSettle().then(() => {
    if (!mediaScheduler.signal.aborted) {
      scheduleMedia("delivery-queue-media", () =>
        runDeliveryQueueMediaGc().catch((error: unknown) => {
          params.logHealth.error(`delivery queue maintenance failed: ${formatError(error)}`);
        }),
      );
    }
  });
  startDevicePairSetupMaintenance({
    scheduler,
    onError: (error) => {
      params.logHealth.error(`device pair setup cleanup failed: ${formatError(error)}`);
    },
  });

  const skillUsageCleanup = registerSkillUsageTracking();

  schedulePeriodic("dedupe", 60_000, () => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = scheduler.now();
    pruneExpiredArtifactDownloads(now);
    params.chatRunState.toolEventRecipients.pruneExpired(now);
    const sources = new Map(
      listRpcSourceEntries().filter(([, source]) => matchesGateway(source.input)),
    );
    const resolveDedupeRunId = (key: string, entry: DedupeEntry) => {
      const keyRunId = key.slice(key.indexOf(":") + 1);
      if (keyRunId && sources.has(keyRunId)) {
        return keyRunId;
      }
      const payload = entry.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId || undefined
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
      const runId = resolveDedupeRunId(key, dedupeEntry);
      const entry = runId ? sources.get(runId) : undefined;
      return entry !== undefined && (entry.adapter.kind === "agent") === key.startsWith("agent:");
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

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    // Prune expired control-plane rate-limit buckets to prevent unbounded
    // growth when many unique clients connect over time.
    pruneStaleControlPlaneBuckets(now);

    // Idle execution and queued delivery retain their projection until their owners settle.
    for (const [runId, record] of params.chatRunState.runs) {
      if (
        sources.has(runId) ||
        hasAgentRunContextExecutionOwner(runId) ||
        isActiveEmbeddedRunId(runId)
      ) {
        continue;
      }
      if (record.abortMarker !== undefined) {
        if (now - chatAbortMarkerTimestampMs(record.abortMarker) <= ABORTED_RUN_TTL_MS) {
          continue;
        }
        params.chatRunState.deleteAbortMarker(runId);
      } else if (now - record.lastActivityAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      while (params.chatRunState.registry.shift(runId)) {
        // No execution or delivery owner remains to consume these registrations.
      }
      params.chatRunState.clearRun(runId);
    }
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed).
    sweepStaleRunContexts();
  });

  const runManagedOutgoingMediaGc =
    params.runManagedOutgoingMediaGc ??
    (async () => {
      const { cleanupManagedOutgoingMediaRecords } = await import("./managed-image-attachments.js");
      return await cleanupManagedOutgoingMediaRecords({
        hasActiveSessionRun: (sessionKey, agentId) => {
          const cfg = params.getRuntimeConfig();
          const defaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
          if (!agentId && !defaultAgentId) {
            return false;
          }
          return hasRegisteredChatRunForSessionKey({
            storePath: resolveSessionStorePathCore(cfg.session?.store, {
              agentId: agentId ?? defaultAgentId,
            }),
            resolveGatewayContext: params.resolveGatewayContext,
            sessionKey,
            agentId,
            defaultAgentId,
          });
        },
      });
    });
  let mediaCleanupStarted = false;
  const startMediaCleanup = () => {
    if (mediaScheduler.signal.aborted || mediaCleanupStarted) {
      return;
    }
    mediaCleanupStarted = true;
    // A stuck prior generation defers only media cleanup, never Gateway readiness.
    void waitForMediaCleanupDrainsToSettle().then(() => {
      if (mediaScheduler.signal.aborted) {
        return;
      }
      scheduleMedia("playback-cache", () =>
        prunePlaybackTranscodeCache().catch((err: unknown) => {
          params.logHealth.error(`playback transcode cache cleanup failed: ${formatError(err)}`);
        }),
      );
      scheduleMedia("managed-outgoing", () =>
        runManagedOutgoingMediaGc().catch((err: unknown) => {
          params.logHealth.error(`managed outgoing media cleanup failed: ${formatError(err)}`);
        }),
      );
      scheduleMedia("media", () => {
        const ttlHours = params.getRuntimeConfig().attachments?.ttlHours;
        const cleanup =
          ttlHours !== undefined
            ? cleanOldMedia(ttlHours * 60 * 60_000, { recursive: true, pruneEmptyDirs: true })
            : pruneOutboundMedia();
        return cleanup.catch((err: unknown) => {
          params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
        });
      });
    });
  };
  let stopMediaCleanupPromise: Promise<MediaCleanupStopResult> | undefined;
  const stopMediaCleanup = () => {
    stopMediaCleanupPromise ??= (async () => {
      registerMediaCleanupDrain(mediaScheduler.stop());
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
      periodicTasksStopPromise = Promise.allSettled([
        scheduler.stop(),
        worktreeMaintenance.stop(),
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
