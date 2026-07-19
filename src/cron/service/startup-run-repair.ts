/** Repairs interrupted and finalized cron runs while the service starts. */
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import {
  clearCronActiveRunOwnershipState,
  tryCronRunInstanceIdentity,
  tryCronRunScheduleIdentity,
  tryCronRunStateIdentity,
  tryCronRunTriggerIdentity,
} from "../schedule-identity.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState } from "./state.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerOnceDisarm,
  applyTriggerRunResult,
  type CronTriggerEvalOutcome,
} from "./timer.js";

export const STARTUP_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";

export type InterruptedStartupRun = {
  jobId: string;
  taskRunId?: string;
  runAtMs: number;
  durationMs: number;
  ownsJobInstance: boolean;
  runInstanceIdentity?: string;
  runScheduleIdentity?: string;
  runScheduleMode?: "advance" | "preserve";
  runStateIdentity?: string;
};

function resolveInterruptedStartupFailureNotificationStatus(params: {
  state: CronServiceState;
  job: CronJob;
}) {
  if (params.job.delivery?.bestEffort === true) {
    return "not-requested";
  }
  if (resolveFailureDestination(params.job, params.state.deps.cronConfig?.failureDestination)) {
    return "unknown";
  }
  const primaryPlan = resolveCronDeliveryPlan(params.job);
  return primaryPlan.mode === "announce" && primaryPlan.requested ? "unknown" : "not-requested";
}

function hasLegacyInterruptedScheduleReplacement(job: CronJob, runningAtMs: number): boolean {
  const hasFutureSlot =
    typeof job.state.nextRunAtMs === "number" && job.state.nextRunAtMs > runningAtMs;
  return (
    hasFutureSlot ||
    (job.schedule.kind === "at" && !job.enabled && job.updatedAtMs > runningAtMs) ||
    (job.schedule.kind === "on-exit" && (job.enabled || job.updatedAtMs > runningAtMs))
  );
}

export function markInterruptedStartupRun(params: {
  state: CronServiceState;
  job: CronJob;
  taskRunId?: string;
  runningAtMs: number;
  nowMs: number;
  runInstanceIdentity?: string;
  runScheduleIdentity?: string;
  runScheduleMode?: "advance" | "preserve";
  runStateIdentity?: string;
}): InterruptedStartupRun {
  const { job, runningAtMs, nowMs } = params;
  const ownsJobInstance =
    params.runInstanceIdentity === undefined ||
    params.runInstanceIdentity === tryCronRunInstanceIdentity(job);
  if (!ownsJobInstance) {
    params.state.deps.log.info(
      { jobId: job.id, runningAtMs },
      "cron: retained replacement job while finalizing interrupted prior instance",
    );
    return {
      jobId: job.id,
      ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
      runAtMs: runningAtMs,
      durationMs: Math.max(0, nowMs - runningAtMs),
      ownsJobInstance: false,
      ...(params.runInstanceIdentity ? { runInstanceIdentity: params.runInstanceIdentity } : {}),
      ...(params.runScheduleIdentity ? { runScheduleIdentity: params.runScheduleIdentity } : {}),
      ...(params.runScheduleMode ? { runScheduleMode: params.runScheduleMode } : {}),
      ...(params.runStateIdentity ? { runStateIdentity: params.runStateIdentity } : {}),
    };
  }
  const preserveSchedule =
    params.runScheduleMode === "preserve" ||
    (params.runScheduleIdentity === undefined &&
      hasLegacyInterruptedScheduleReplacement(job, runningAtMs)) ||
    (params.runScheduleIdentity !== undefined &&
      params.runScheduleIdentity !== tryCronRunScheduleIdentity(job));
  const preservedScheduleState = preserveSchedule
    ? {
        enabled: job.enabled,
        nextRunAtMs: job.state.nextRunAtMs,
        startupCatchupAtMs: job.state.startupCatchupAtMs,
        pacedNextRunAtMs: job.state.pacedNextRunAtMs,
        forcePreservedNextRunAtMs: job.state.forcePreservedNextRunAtMs,
      }
    : undefined;
  // A persisted running marker means the gateway stopped mid-run; mark it as a
  // normal failed run so retries, alerts, and run logs all see one outcome.
  const failureNotificationStatus = resolveInterruptedStartupFailureNotificationStatus({
    state: params.state,
    job,
  });
  const previousErrors =
    typeof job.state.consecutiveErrors === "number" && Number.isFinite(job.state.consecutiveErrors)
      ? Math.max(0, Math.floor(job.state.consecutiveErrors))
      : 0;

  params.state.deps.log.warn(
    { jobId: job.id, runningAtMs },
    "cron: marking interrupted running job failed on startup",
  );

  job.state.runningAtMs = undefined;
  clearCronActiveRunOwnershipState(job.state);
  job.state.lastRunAtMs = runningAtMs;
  job.state.lastRunStatus = "error";
  job.state.lastStatus = "error";
  job.state.lastError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
  job.state.consecutiveErrors = previousErrors + 1;
  job.state.lastDelivered = false;
  job.state.lastDeliveryStatus = "unknown";
  job.state.lastDeliveryError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = failureNotificationStatus;
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.nextRunAtMs = undefined;
  job.updatedAtMs = nowMs;

  if (job.schedule.kind === "at") {
    job.enabled = false;
  }
  if (preservedScheduleState) {
    job.enabled = preservedScheduleState.enabled;
    job.state.nextRunAtMs = preservedScheduleState.nextRunAtMs;
    job.state.startupCatchupAtMs = preservedScheduleState.startupCatchupAtMs;
    job.state.pacedNextRunAtMs = preservedScheduleState.pacedNextRunAtMs;
    job.state.forcePreservedNextRunAtMs =
      params.runScheduleMode === "preserve"
        ? preservedScheduleState.nextRunAtMs
        : preservedScheduleState.forcePreservedNextRunAtMs;
  }

  return {
    jobId: job.id,
    ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
    runAtMs: runningAtMs,
    durationMs: job.state.lastDurationMs,
    ownsJobInstance: true,
    ...(params.runInstanceIdentity ? { runInstanceIdentity: params.runInstanceIdentity } : {}),
    ...(params.runScheduleIdentity ? { runScheduleIdentity: params.runScheduleIdentity } : {}),
    ...(params.runScheduleMode ? { runScheduleMode: params.runScheduleMode } : {}),
    ...(params.runStateIdentity ? { runStateIdentity: params.runStateIdentity } : {}),
  };
}

export function restoreFinalizedStartupRun(params: {
  state: CronServiceState;
  job: CronJob;
  runningAtMs: number;
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: unknown };
  triggerEval?: CronTriggerEvalOutcome;
  runScheduleIdentity?: string;
  runScheduleMode?: "advance" | "preserve";
  runTriggerIdentity?: string;
  runStateIdentity?: string;
}): boolean {
  const { state, job, runningAtMs, entry } = params;
  const startedAt = entry.runAtMs ?? runningAtMs;
  // Older finalized task rows have no execution identity. A job edited after
  // admission is replacement scheduler state and must survive recovery.
  const hasReplacementTimedSlot =
    typeof job.state.nextRunAtMs === "number" &&
    job.state.nextRunAtMs > runningAtMs &&
    (job.schedule.kind === "at" || job.state.nextRunAtMs !== entry.nextRunAtMs);
  const preserveLegacyReplacement =
    params.runScheduleIdentity === undefined &&
    (hasReplacementTimedSlot ||
      (job.schedule.kind === "at" && !job.enabled && job.updatedAtMs > runningAtMs) ||
      (job.schedule.kind === "on-exit" && (job.enabled || job.updatedAtMs > runningAtMs)));
  const currentRunScheduleIdentity = tryCronRunScheduleIdentity(job);
  const mayApplyRecoveredState =
    params.runStateIdentity !== undefined
      ? params.runStateIdentity === tryCronRunStateIdentity(job)
      : job.updatedAtMs <= runningAtMs;
  const mayApplyRecoveredTrigger =
    params.runTriggerIdentity !== undefined
      ? params.runTriggerIdentity === tryCronRunTriggerIdentity(job)
      : mayApplyRecoveredState;
  const scheduleMode =
    params.runScheduleMode === "preserve" ||
    preserveLegacyReplacement ||
    (params.runScheduleIdentity !== undefined &&
      params.runScheduleIdentity !== currentRunScheduleIdentity)
      ? "preserve"
      : "advance";
  const shouldDelete = applyJobResult(
    state,
    job,
    {
      ...entry,
      startedAt,
      endedAt: entry.ts,
    },
    { replayFailureAlertAtMs: entry.ts, scheduleMode },
  );

  // The finalized row captured post-run state before the stale cron store write.
  job.state.lastDurationMs = entry.durationMs ?? Math.max(0, entry.ts - startedAt);
  job.state.lastErrorReason = entry.errorReason;
  job.state.lastDelivered = entry.delivered;
  job.state.lastDeliveryStatus = entry.deliveryStatus;
  job.state.lastDeliveryError = entry.deliveryError;
  job.state.lastFailureNotificationDelivered = entry.failureNotificationDelivery?.delivered;
  job.state.lastFailureNotificationDeliveryStatus = entry.failureNotificationDelivery?.status;
  job.state.lastFailureNotificationDeliveryError = entry.failureNotificationDelivery?.error;
  if (scheduleMode === "advance") {
    job.state.nextRunAtMs = entry.nextRunAtMs;
    // The finalized ledger row owns the schedule decision made before the stale
    // store write. No next run means that one-shot was permanently disabled.
    if (job.schedule.kind === "at" && entry.nextRunAtMs === undefined) {
      job.enabled = false;
    }
  }
  if (params.triggerEval && mayApplyRecoveredState) {
    applyTriggerRunResult(job, {
      status: entry.status,
      endedAt: entry.ts,
      triggerEval: params.triggerEval,
    });
  } else if (params.triggerEval && mayApplyRecoveredTrigger) {
    applyTriggerOnceDisarm(job, {
      status: entry.status,
      triggerEval: params.triggerEval,
    });
  }
  if (params.scriptResult && mayApplyRecoveredState) {
    // The payload script is the final writer when a trigger and payload both
    // update their shared state during the same successful run.
    applyScriptRunResult(job, { status: entry.status, ...params.scriptResult });
  }
  state.deps.log.info(
    { jobId: job.id, runningAtMs, status: entry.status },
    "cron: restored finalized task-ledger run on startup",
  );
  return shouldDelete;
}

export function mergeManualRunSnapshotAfterReload(params: {
  state: CronServiceState;
  jobId: string;
  snapshot: {
    enabled: boolean;
    updatedAtMs: number;
    state: CronJob["state"];
  } | null;
  removed: boolean;
}) {
  if (!params.state.store) {
    return;
  }
  if (params.removed) {
    params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
    return;
  }
  if (!params.snapshot) {
    return;
  }
  const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
  if (!reloaded) {
    return;
  }
  reloaded.enabled = params.snapshot.enabled;
  reloaded.updatedAtMs = params.snapshot.updatedAtMs;
  reloaded.state = params.snapshot.state;
}
