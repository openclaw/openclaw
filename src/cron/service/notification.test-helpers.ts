import { resolveCronRunErrorReason } from "../run-error-reason.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult, applyTriggerNoFireResult } from "./timer-outcomes.js";

export async function applyJobResultAndDrainNotifications(
  state: CronServiceState,
  job: Parameters<typeof applyJobResult>[1],
  result: Omit<Parameters<typeof applyJobResult>[2], "errorReason">,
): Promise<boolean> {
  const deferredNotifications: DeferredCronNotifications = [];
  const shouldDelete = applyJobResult(
    state,
    job,
    {
      ...result,
      errorReason: resolveCronRunErrorReason(
        result.error,
        result.provider,
        result.errorClassification,
      ),
    },
    { deferredNotifications },
  );
  await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
  return shouldDelete;
}

export async function applyTriggerNoFireResultAndDrainNotifications(
  state: CronServiceState,
  job: Parameters<typeof applyTriggerNoFireResult>[1],
  result: Parameters<typeof applyTriggerNoFireResult>[2],
): Promise<void> {
  const deferredNotifications: DeferredCronNotifications = [];
  applyTriggerNoFireResult(state, job, result, { deferredNotifications });
  await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
}
