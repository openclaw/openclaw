import type { InterruptedStartupRun } from "../store/run-recovery.types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { finishCronRun } from "./run-history.js";
import { STARTUP_INTERRUPTED_ERROR } from "./startup-run-repair.js";
import { emit, type CronServiceState } from "./state.js";

export async function emitInterruptedCronRun(
  state: CronServiceState,
  interrupted: InterruptedStartupRun,
): Promise<void> {
  const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
  const event = {
    jobId: interrupted.jobId,
    action: "finished",
    job,
    status: "error",
    completionStatus: "failed",
    error: STARTUP_INTERRUPTED_ERROR,
    delivered: false,
    deliveryStatus: "unknown",
    deliveryError: STARTUP_INTERRUPTED_ERROR,
    failureNotificationDelivery: job ? failureNotificationDeliveryFromJobState(job) : undefined,
    runAtMs: interrupted.runAtMs,
    durationMs: interrupted.durationMs,
    nextRunAtMs: job?.state.nextRunAtMs,
  } as const;
  await finishCronRun(state, { taskRunId: interrupted.taskRunId, job, event });
  emit(state, event);
}
