import { resolveCronCompletionStatus } from "../completion-status.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type {
  CronFailureNotificationDetail,
  CronJob,
  CronRunErrorClassification,
  CronTriggerEvalOutcome,
} from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { finishCronRun } from "./run-history.js";
import {
  cronFailureNotificationEventContext,
  emit,
  type CronEvent,
  type CronServiceState,
} from "./state.js";
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

function createCronOutcomeEvent(job: CronJob, result: TimedCronRunOutcome) {
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
    ...(result.request ? { runId: result.request.runId } : {}),
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
  if (result.request?.terminalTracker) {
    result.request.terminalTracker.emitted = true;
  }
}

export type ManualRunTerminalTracker = { emitted: boolean };

export async function emitCronRunFinished(
  state: CronServiceState,
  evt: CronEvent & { action: "finished" },
  tracker?: ManualRunTerminalTracker,
  taskRunId?: string,
  details?: {
    triggerEval?: CronTriggerEvalOutcome;
    scriptResult?: { scriptStateChanged?: boolean; scriptState?: unknown };
    errorClassification?: CronRunErrorClassification;
    failureNotificationDetail?: CronFailureNotificationDetail;
    historySource?: CronRunHistorySource;
  },
): Promise<void> {
  const event = {
    ...evt,
    completionStatus:
      evt.completionStatus ??
      resolveCronCompletionStatus({ status: evt.status, deliveryStatus: evt.deliveryStatus }),
  };
  await finishCronRun(state, {
    taskRunId,
    job: evt.job,
    event,
    historySource: details?.historySource,
    errorClassification: details?.errorClassification,
    ...(details?.scriptResult ? { scriptResult: details.scriptResult } : {}),
    ...(details?.triggerEval ? { triggerEval: details.triggerEval } : {}),
  });
  details?.historySource?.assertCurrent();
  emit(state, event, cronFailureNotificationEventContext(details?.failureNotificationDetail));
  if (tracker) {
    tracker.emitted = true;
  }
}

/** Queued requests need an acknowledgement even when no payload outcome is published. */
export async function emitMissingRequestedCronRunTerminal(
  state: CronServiceState,
  result: TimedCronRunOutcome,
  required = false,
): Promise<void> {
  const request = result.request;
  if (!request || (!request.terminalTracker && !required) || request.terminalTracker?.emitted) {
    return;
  }
  const quiet = result.status === "ok" && result.triggerEval?.fired === false;
  const job =
    result.activeJobMarker?.jobRemoved === true
      ? request.executionJob
      : state.store?.jobs.find((entry) => entry.id === result.jobId);
  await emitCronRunFinished(
    state,
    {
      jobId: result.jobId,
      action: "finished",
      job,
      status: quiet ? "skipped" : result.status,
      completionStatus: quiet ? "failed" : result.completionStatus,
      error: quiet ? "queued manual run skipped: trigger condition not met" : result.error,
      deliveryError: result.deliveryState.error,
      deliverySuppressionReason: result.deliveryState.deliverySuppressionReason,
      summary: quiet ? undefined : result.summary,
      diagnostics: result.diagnostics,
      delivered: result.deliveryState.delivered,
      deliveryStatus: result.deliveryState.status,
      delivery: result.delivery,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
      runId: request.runId,
      runAtMs: result.startedAt,
      durationMs: Math.max(0, result.endedAt - result.startedAt),
      nextRunAtMs: job?.state.nextRunAtMs,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
    },
    request.terminalTracker,
    result.taskRunId,
    {
      errorClassification: quiet ? undefined : result.errorClassification,
      failureNotificationDetail: quiet ? undefined : result.failureNotificationDetail,
    },
  );
}
