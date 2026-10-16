import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronRunLogEntryFromEvent } from "../run-event-codec.js";
import {
  cronQuietTriggerDetail,
  cronRunLogEntryToDetail,
  cronRunStorageStatus,
} from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import { failureNotificationDeliveryFromJobState } from "../service/failure-alerts.js";
import type { CronEvent } from "../service/state.js";
import type { CronJob } from "../types.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";
import type { CronRunFinalizationOutcome } from "./runtime-worker.types.js";

/** The persisted terminal fact and the published event describe the same result. */
export function cronRunResultEvent(
  job: CronJob,
  result: CronRunFinalizationOutcome,
): CronEvent & { action: "finished" } {
  const quiet = result.status === "ok" && result.triggerEval?.fired === false;
  return {
    jobId: job.id,
    action: "finished",
    job,
    status: quiet ? "skipped" : result.status,
    completionStatus: quiet ? "failed" : result.completionStatus,
    error: quiet ? "queued manual run skipped: trigger condition not met" : result.error,
    summary: quiet ? undefined : result.summary,
    diagnostics: result.diagnostics,
    delivered: result.deliveryState.delivered,
    deliveryStatus: result.deliveryState.status,
    deliveryError: result.deliveryState.error,
    deliverySuppressionReason: result.deliveryState.deliverySuppressionReason,
    failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    delivery: result.delivery,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runId: result.request?.runId,
    runAtMs: result.startedAt,
    durationMs: Math.max(0, result.endedAt - result.startedAt),
    nextRunAtMs: job.state.nextRunAtMs,
    ...(result.triggerEval?.fired ? { triggerFired: true } : {}),
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  };
}

export function cronRunResultHistory(
  storeKey: string,
  job: CronJob,
  result: CronRunFinalizationOutcome,
  defaultAgentId?: string,
): CronRunHistoryWrite {
  const quiet = result.status === "ok" && result.triggerEval?.fired === false;
  const entry = cronRunLogEntryFromEvent(
    cronRunResultEvent(job, result),
    result.endedAt,
    result.errorClassification,
  );
  return {
    storeKey,
    jobId: result.jobId,
    runId:
      result.taskRunId ??
      `${createCronExecutionId(result.jobId, result.startedAt)}:${result.runReceipt?.receiptId ?? result.request?.runId ?? "terminal"}`,
    agentId:
      result.runReceipt?.agentId ?? tryResolveCronJobEffectiveAgentId(result.job, defaultAgentId),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    sessionKey: result.sessionKey,
    status: quiet && !result.request?.runId ? "succeeded" : cronRunStorageStatus(entry),
    error: quiet && !result.request?.runId ? undefined : entry.error,
    summary: entry.summary,
    detail:
      quiet && !result.request?.runId && result.triggerEval
        ? cronQuietTriggerDetail(storeKey, { ...result.triggerEval, fired: false })
        : cronRunLogEntryToDetail(entry, {
            storeKey,
            scriptResult: result,
            triggerEval: result.triggerEval,
          }),
  };
}
