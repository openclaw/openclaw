/** Repairs interrupted and finalized cron runs while the service starts. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveCronCompletionStatus } from "../completion-status.js";
import { STARTUP_INTERRUPTED_ERROR } from "../execution-error-constants.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { InterruptedStartupRun } from "../store/run-recovery.types.js";
import type { CronJob, CronRunStatus, CronTriggerEvalOutcome } from "../types.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";
import {
  applyJobResult,
  applyScriptRunResult,
  applyTriggerNoFireResult,
} from "./timer-outcomes.js";
import { applyTriggerRunResult } from "./timer-trigger.js";

function resolveOneShotReplacementAtMs(job: CronJob, runningAtMs: number): number | undefined {
  if (job.schedule.kind !== "at" || !job.enabled) {
    return undefined;
  }
  const nextRunAtMs = job.state.nextRunAtMs;
  if (typeof nextRunAtMs !== "number" || nextRunAtMs <= runningAtMs) {
    return undefined;
  }
  // Compare against the run's durable start, not the restart clock: a newer
  // one-shot may already be overdue and must remain eligible for catch-up.
  return parseAbsoluteTimeMs(job.schedule.at) === nextRunAtMs ? nextRunAtMs : undefined;
}

export function markInterruptedStartupRun(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  runningAtMs: number;
  preservedOccurrenceAtMs?: number;
  restartRetryAtMs?: number;
  nowMs: number;
}): InterruptedStartupRun {
  const { job, runningAtMs, nowMs } = params;
  const replacementAtMs =
    params.preservedOccurrenceAtMs ??
    resolveOneShotReplacementAtMs(job, runningAtMs) ??
    params.restartRetryAtMs;
  // An interrupted run remains visible, but is not a failure of the job itself.
  params.state.deps.log.warn(
    { jobId: job.id, runningAtMs },
    "cron: marking interrupted running job failed on startup",
  );

  job.state.runningAtMs = undefined;
  job.state.runningReceiptId = undefined;
  delete job.state.runningScheduleChangeId;
  job.state.lastRunAtMs = runningAtMs;
  job.state.lastRunStatus = "error";
  job.state.lastStatus = "error";
  job.state.lastError = STARTUP_INTERRUPTED_ERROR;
  job.state.lastErrorReason = undefined;
  job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
  job.state.lastDelivered = false;
  job.state.lastDeliveryStatus = "unknown";
  job.state.lastDeliveryError = STARTUP_INTERRUPTED_ERROR;
  job.state.deliverySuppressionReason = undefined;
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "not-requested";
  job.state.lastFailureNotificationDeliveryError = undefined;
  job.state.nextRunAtMs = replacementAtMs;
  job.state.startupCatchupAtMs =
    params.restartRetryAtMs === replacementAtMs ? replacementAtMs : undefined;
  job.updatedAtMs = nowMs;

  // An uncertain started one-shot is never replayed; a distinct replacement keeps its slot.
  if (job.schedule.kind === "at" && replacementAtMs === undefined) {
    job.enabled = false;
  }

  return {
    jobId: job.id,
    ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
    runAtMs: runningAtMs,
    durationMs: job.state.lastDurationMs,
  };
}

export function restoreFinalizedStartupRun(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  runningAtMs: number;
  preservedOccurrenceAtMs?: number;
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: unknown };
  triggerEval?: CronTriggerEvalOutcome;
  triggerStateRetired?: boolean;
  deferredNotifications: DeferredCronNotifications;
}): { shouldDelete: boolean; replacementAtMs?: number } | undefined {
  const { state, job, runningAtMs, entry } = params;
  const triggerOwnership = params.triggerStateRetired ? "stale" : "current";
  const startedAt = asDateTimestampMs(entry.runAtMs ?? runningAtMs);
  const endedAt = asDateTimestampMs(entry.ts);
  if (startedAt === undefined || startedAt < 0 || endedAt === undefined || endedAt < 0) {
    state.deps.log.warn(
      { jobId: job.id },
      "cron: ignoring finalized startup run with an invalid timestamp envelope",
    );
    return undefined;
  }
  const replacementAtMs =
    (entry.nextRunAtMs === params.preservedOccurrenceAtMs
      ? params.preservedOccurrenceAtMs
      : undefined) ?? resolveOneShotReplacementAtMs(job, startedAt);
  const persistedNextRunAtMs = asDateTimestampMs(job.state.nextRunAtMs);
  // Committed edits own scheduling even if the clock repeats or moves back.
  // Legacy split-write finalization can leave a newer retry deadline in the job row.
  const scheduleOwnership =
    typeof job.state.runningScheduleChangeId === "string" ||
    (job.schedule.kind === "at" &&
      (!job.enabled ||
        replacementAtMs !== undefined ||
        (persistedNextRunAtMs !== undefined && persistedNextRunAtMs > startedAt)))
      ? "stale"
      : "current";
  // A once result can record no next run before a later edit retires its
  // state writer. That old absence cannot unschedule the replacement.
  const retiredTriggerStoppedSchedule =
    params.triggerStateRetired &&
    params.triggerEval?.fired === true &&
    entry.status === "ok" &&
    entry.nextRunAtMs === undefined;
  job.state.startupCatchupAtMs = undefined;
  if (params.triggerEval?.fired === false) {
    applyTriggerNoFireResult(
      state,
      job,
      { startedAt, endedAt, triggerEval: params.triggerEval },
      {
        scheduleMode: scheduleOwnership === "stale" ? "stale-preserve" : "advance",
        triggerOwnership,
        replay: true,
        deferredNotifications: params.deferredNotifications,
      },
    );
    return {
      shouldDelete: false,
      ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
    };
  }
  const completionStatus =
    entry.completionStatus ??
    resolveCronCompletionStatus({
      status: entry.status,
      delivered: entry.delivered,
      deliveryStatus: entry.deliveryStatus,
    });
  const shouldDelete = applyJobResult(
    state,
    job,
    {
      ...entry,
      completionStatus,
      // Recovery uses the finished run's fact, never the job's possibly edited route.
      deliveryState: {
        delivered: entry.delivered,
        status: entry.deliveryStatus ?? "unknown",
        error: entry.deliveryError,
        deliverySuppressionReason: entry.deliverySuppressionReason,
        failureNotification: entry.failureNotificationDelivery ?? { status: "not-requested" },
      },
      startedAt,
      endedAt,
    },
    {
      replay: true,
      scheduleOwnership,
      ...(scheduleOwnership === "current" && !retiredTriggerStoppedSchedule
        ? { replaySchedule: { nextRunAtMs: entry.nextRunAtMs } }
        : {}),
      deferredNotifications: params.deferredNotifications,
    },
  );

  // The finalized row captured post-run state before the stale cron store write.
  job.state.lastDurationMs = entry.durationMs ?? Math.max(0, endedAt - startedAt);
  job.state.lastErrorReason = entry.errorReason;
  if (entry.failureNotificationDelivery) {
    job.state.lastFailureNotificationDelivered = entry.failureNotificationDelivery.delivered;
    job.state.lastFailureNotificationDeliveryStatus = entry.failureNotificationDelivery.status;
    job.state.lastFailureNotificationDeliveryError = entry.failureNotificationDelivery.error;
    const lastAlert = job.state.lastFailureAlertAtMs;
    // Failure alert intent owns its cooldown; a recorded recovery notice does not reopen it.
    if (
      entry.failureNotificationDelivery.status !== "not-requested" &&
      completionStatus !== "succeeded" &&
      (lastAlert === undefined || lastAlert < endedAt || lastAlert > state.deps.nowMs())
    ) {
      job.state.lastFailureAlertAtMs = endedAt;
    }
  }
  if (params.triggerEval) {
    applyTriggerRunResult(
      job,
      {
        status: entry.status,
        endedAt,
        triggerEval: params.triggerEval,
      },
      { scheduleOwnership, triggerOwnership },
    );
  }
  if (params.scriptResult) {
    // The payload script is the final writer when a trigger and payload both
    // update their shared state during the same successful run.
    applyScriptRunResult(
      job,
      { status: entry.status, ...params.scriptResult },
      { triggerOwnership },
    );
  }
  state.deps.log.info(
    { jobId: job.id, runningAtMs, status: entry.status },
    "cron: restored finalized run history on startup",
  );
  return {
    shouldDelete,
    ...(replacementAtMs === undefined ? {} : { replacementAtMs }),
  };
}
