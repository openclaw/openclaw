import { resolveCronCompletionStatus } from "../completion-status.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type {
  CronFailureNotificationDetail,
  CronRunErrorClassification,
  CronTriggerEvalOutcome,
} from "../types.js";
import { finishCronRun } from "./run-history.js";
import {
  cronFailureNotificationEventContext,
  emit,
  type CronEvent,
  type CronServiceState,
} from "./state.js";

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
  emit(state, event, cronFailureNotificationEventContext(details?.failureNotificationDetail));
  if (tracker) {
    tracker.emitted = true;
  }
}
