import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { finishCronRun } from "./run-history.js";
import { cronFailureNotificationEventContext, emit, type CronServiceState } from "./state.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

/** Records a terminal task/event fact before the fallible runtime-row commit. */
export async function emitCronOutcomeForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): Promise<void> {
  if (result.status === "ok" && result.triggerEval && !result.triggerEval.fired) {
    return;
  }
  await recordCronOutcomeForJob(state, job, result);
  emitCronOutcomeEventForJob(state, job, result);
}

export function createCronOutcomeEvent(job: CronJob, result: TimedCronRunOutcome) {
  return {
    jobId: job.id,
    action: "finished",
    job,
    status: result.status,
    completionStatus: result.completionStatus,
    error: result.error,
    summary: result.summary,
    diagnostics: result.diagnostics,
    delivered: job.state.lastDelivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    delivery: result.delivery,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs: result.startedAt,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    ...(result.triggerEval?.fired ? { triggerFired: true } : {}),
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  } as const;
}

export async function recordCronOutcomeForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): Promise<void> {
  const event = createCronOutcomeEvent(job, result);
  await finishCronRun(state, {
    taskRunId: result.taskRunId,
    job,
    event,
    errorClassification: result.errorClassification,
    scriptResult: {
      scriptStateChanged: result.scriptStateChanged,
      scriptState: result.scriptState,
    },
    ...(result.triggerEval ? { triggerEval: result.triggerEval } : {}),
  });
}

export function emitCronOutcomeEventForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): void {
  emit(
    state,
    createCronOutcomeEvent(job, result),
    cronFailureNotificationEventContext(result.failureNotificationDetail),
  );
}
