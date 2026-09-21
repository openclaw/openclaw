import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult, applyTriggerNoFireResult } from "./timer-outcomes.js";

export function applyJobResultAndDrainNotifications(
  state: CronServiceState,
  job: Parameters<typeof applyJobResult>[1],
  result: Parameters<typeof applyJobResult>[2],
): boolean {
  const deferredNotifications: DeferredCronNotifications = [];
  const shouldDelete = applyJobResult(state, job, result, { deferredNotifications });
  runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
  return shouldDelete;
}

export function applyTriggerNoFireResultAndDrainNotifications(
  state: CronServiceState,
  job: Parameters<typeof applyTriggerNoFireResult>[1],
  result: Parameters<typeof applyTriggerNoFireResult>[2],
): void {
  const deferredNotifications: DeferredCronNotifications = [];
  applyTriggerNoFireResult(state, job, result, { deferredNotifications });
  runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
}
