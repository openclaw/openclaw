import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const TASK_SWEEP_INTERVAL_MS = 60_000;

export function createTaskMaintenanceScheduler(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let sweepJob: GatewayScheduledJob | undefined;
  let scheduledSweep: { completion: Promise<void>; cancelAdmission: () => void } | null = null;

  function startScheduledSweep(schedulerSignal: AbortSignal) {
    if (scheduledSweep) {
      return scheduledSweep.completion;
    }
    const admission = new AbortController();
    const signal = AbortSignal.any([admission.signal, schedulerSignal]);
    let admitted = false;
    const completion = runWithGatewayIndependentRootWorkAdmission(
      async () => {
        admitted = true;
        await run();
      },
      "tasks:maintenance",
      signal,
    )
      .catch((error: unknown) => {
        // A restart can refuse the tick before a sweep starts; admitted failures still need reporting.
        if (admitted || (!signal.aborted && !isGatewayRestartDrainError(error))) {
          onError(error);
        }
      })
      .finally(() => {
        scheduledSweep = null;
      });
    scheduledSweep = { completion, cancelAdmission: () => admission.abort() };
    return completion;
  }

  return {
    start(scheduler: GatewayScheduler) {
      if (sweepJob) {
        return;
      }
      sweepJob = scheduler.schedule({
        id: "task-registry-maintenance",
        atMs: scheduler.now() + 5_000,
        everyMs: TASK_SWEEP_INTERVAL_MS,
        run: () => startScheduledSweep(scheduler.signal),
      });
    },
    async stop(): Promise<void> {
      sweepJob?.cancel();
      sweepJob = undefined;
      const pending = scheduledSweep;
      pending?.cancelAdmission();
      // Admission cancellation leaves already-started work owned until it settles.
      await pending?.completion;
    },
  };
}
