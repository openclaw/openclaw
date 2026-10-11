import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { isCronTimeoutErrorText } from "../execution-error-constants.js";
import { type CronRetryOn, resolveCronExecutionRetryHint } from "../retry-hint.js";
import {
  CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
  hasCanonicalCronDeliveryMode,
} from "../store/delivery-codec.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import type {
  CronJob,
  CronDeliveryTrace,
  CronFailureNotificationDetail,
  CronResolvedDeliveryState,
  CronRunErrorClassification,
  CronRunStatus,
  CronTriggerEvalOutcome,
} from "../types.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  errorBackoffMs,
  resolveNextRunAtMsOrDisable,
} from "./jobs-scheduling.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

/** Default max retries for cron jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

type TransientCronRetryDecision = {
  retryable: boolean;
  consecutiveErrors: number;
  retryCategory?: CronRetryOn;
  backoffMs?: number;
  reason: "transient retry" | "max retries exhausted" | "permanent error";
};

/** Persists non-busy trigger evaluation state without touching payload-run history. */
export function applyTriggerEvaluationState(
  job: CronJob,
  triggerEval: CronTriggerEvalOutcome,
  evaluatedAtMs: number,
): void {
  if (triggerEval.busy) {
    return;
  }
  job.state.lastTriggerEvalAtMs = evaluatedAtMs;
  job.state.triggerEvalCount = (job.state.triggerEvalCount ?? 0) + 1;
  if (triggerEval.stateChanged) {
    job.state.triggerState = triggerEval.state;
  }
  if (triggerEval.fired) {
    job.state.lastTriggerFireAtMs = evaluatedAtMs;
  }
}

/** Persists fired/error trigger metadata and disarms successful once triggers. */
export function applyTriggerRunResult(
  job: CronJob,
  result: { status: CronRunStatus; endedAt: number; triggerEval?: CronTriggerEvalOutcome },
  opts?: { scheduleOwnership?: "current" | "stale"; triggerOwnership?: "current" | "stale" },
): void {
  if (!result.triggerEval || opts?.triggerOwnership === "stale") {
    return;
  }
  // Failed payloads keep the old state so the next evaluation re-detects the event.
  const persistedEval =
    result.status === "ok"
      ? result.triggerEval
      : { ...result.triggerEval, stateChanged: false, state: undefined };
  applyTriggerEvaluationState(job, persistedEval, result.endedAt);
  if (
    opts?.scheduleOwnership !== "stale" &&
    result.triggerEval.fired &&
    job.trigger?.once === true &&
    result.status === "ok"
  ) {
    if (job.schedule.kind === "stream") {
      job.state.streamSourceIdentity = createCronStreamSourceIdentity();
    }
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
  }
}

export function resolveCronNextRunWithLowerBound(params: {
  state: CronJobPolicyContext;
  job: CronJob;
  naturalNext: number | undefined;
  lowerBoundMs: number;
  deferredNotifications: DeferredCronNotifications;
}): number | undefined {
  if (params.naturalNext === undefined) {
    params.state.deps.log.warn(
      {
        jobId: params.job.id,
        jobName: params.job.name,
      },
      "cron: next run unresolved; clearing schedule to avoid a refire loop",
    );
    return undefined;
  }
  return resolveNextRunAtMsOrDisable({
    state: params.state,
    job: params.job,
    candidate: Math.max(params.naturalNext, params.lowerBoundMs),
    deferredNotifications: params.deferredNotifications,
  });
}

/**
 * True when a scheduled quick re-run targets a provider outage, so the failure alert and
 * owner repair wait for it. Provider transport failures (DNS, refused connections, request
 * timeouts) classify as `timeout`. Failures the job owns are not held: its scripts, command
 * payloads, and cron's own execution watchdog usually need the owner repair promptly.
 */
export function holdsFailureNotificationForRetry(
  job: CronJob,
  result: { error?: string; failureNotificationDetail?: CronFailureNotificationDetail },
  category: CronRetryOn | undefined,
): boolean {
  if (category === undefined || result.failureNotificationDetail?.kind === "script-failure") {
    return false;
  }
  return (
    category !== "timeout" ||
    (job.payload.kind !== "command" && !isCronTimeoutErrorText(result.error))
  );
}

export function resolveTransientCronRetryDecision(params: {
  error: string | undefined;
  errorClassification?: CronRunErrorClassification;
  lastErrorReason?: CronJob["state"]["lastErrorReason"];
  executionStarted?: boolean;
  consecutiveErrors: number | undefined;
}): TransientCronRetryDecision {
  if (params.errorClassification?.kind === "permanent") {
    return {
      retryable: false,
      consecutiveErrors: params.consecutiveErrors ?? 0,
      reason: "permanent error",
    };
  }
  const retryHint = resolveCronExecutionRetryHint({
    error: params.error,
    retryOn: undefined,
    classifiedReason:
      params.errorClassification?.kind === "reason"
        ? params.errorClassification.reason
        : params.lastErrorReason,
    executionStarted: params.executionStarted,
  });
  const consecutiveErrors = params.consecutiveErrors ?? 0;
  if (!retryHint.retryable) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "permanent error",
    };
  }
  if (consecutiveErrors > DEFAULT_MAX_TRANSIENT_RETRIES) {
    return {
      retryable: false,
      consecutiveErrors,
      retryCategory: retryHint.category,
      reason: "max retries exhausted",
    };
  }
  return {
    retryable: true,
    consecutiveErrors,
    retryCategory: retryHint.category,
    backoffMs: errorBackoffMs(
      consecutiveErrors,
      DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, DEFAULT_MAX_TRANSIENT_RETRIES),
    ),
    reason: "transient retry",
  };
}

export function resolveDeliveryState(params: {
  job: CronJob;
  runStatus: CronRunStatus;
  delivery?: CronDeliveryTrace;
  delivered?: boolean;
  deliveryAttempted?: boolean;
  error?: string;
  deliverySuppressionReason?: CronResolvedDeliveryState["deliverySuppressionReason"];
}): CronResolvedDeliveryState {
  const noFailureNotification = { status: "not-requested" as const };
  const verifiedDelivery =
    params.delivered === true &&
    (params.runStatus !== "error" || params.delivery?.delivered === true);
  if (verifiedDelivery) {
    return {
      delivered: true,
      status: "delivered",
      failureNotification: noFailureNotification,
    };
  }
  if (!hasCanonicalCronDeliveryMode(params.job.delivery)) {
    return {
      status: "unknown",
      error: CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
      failureNotification: noFailureNotification,
    };
  }
  const primaryDeliveryPlan = resolveCronDeliveryPlan(params.job);
  const primaryDeliveryRequested = primaryDeliveryPlan.requested;
  if (!primaryDeliveryRequested) {
    if (primaryDeliveryPlan.mode === "webhook" && params.deliveryAttempted === true) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        failureNotification: noFailureNotification,
      };
    }
    return {
      status: "not-requested",
      failureNotification: noFailureNotification,
    };
  }
  if (params.runStatus === "error") {
    if (params.delivered !== undefined) {
      return {
        delivered: false,
        status: "not-delivered",
        error: params.error,
        deliverySuppressionReason: params.deliverySuppressionReason,
        failureNotification: noFailureNotification,
      };
    }
    return {
      status: "unknown",
      error: params.error,
      failureNotification: noFailureNotification,
    };
  }
  if (params.delivered === false) {
    return {
      delivered: false,
      status: "not-delivered",
      error: params.error,
      deliverySuppressionReason: params.deliverySuppressionReason,
      failureNotification: { status: "not-requested" },
    };
  }
  return { status: "unknown", failureNotification: { status: "not-requested" } };
}
