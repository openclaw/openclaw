import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

const TASK_SWEEP_INTERVAL_MS = 60_000;

export function createTaskMaintenanceScheduler(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let sweeper: NodeJS.Timeout | null = null;
  let deferredSweep: NodeJS.Timeout | null = null;
  let scheduledSweep: { completion: Promise<void>; cancelAdmission: () => void } | null = null;

  function startScheduledSweep() {
    if (!sweeper || scheduledSweep) {
      return;
    }
    const admission = new AbortController();
    let admitted = false;
    const completion = runWithGatewayIndependentRootWorkAdmission(
      async () => {
        admitted = true;
        await run();
      },
      "tasks:maintenance",
      admission.signal,
    )
      .catch((error: unknown) => {
        if (admitted || !admission.signal.aborted) {
          onError(error);
        }
      })
      .finally(() => {
        scheduledSweep = null;
      });
    scheduledSweep = { completion, cancelAdmission: () => admission.abort() };
  }

  return {
    start() {
      if (sweeper) {
        return;
      }
      deferredSweep = setTimeout(() => {
        deferredSweep = null;
        startScheduledSweep();
      }, 5_000);
      deferredSweep.unref?.();
      sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
      sweeper.unref?.();
    },
    async stop(): Promise<void> {
      if (deferredSweep) {
        clearTimeout(deferredSweep);
        deferredSweep = null;
      }
      if (sweeper) {
        clearInterval(sweeper);
        sweeper = null;
      }
      const pending = scheduledSweep;
      pending?.cancelAdmission();
      // Admission cancellation leaves already-started work owned until it settles.
      await pending?.completion;
    },
  };
}
