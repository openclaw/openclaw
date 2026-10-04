import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const CRON_SWEEP_INTERVAL_MS = 60_000;

export function createCronMaintenanceScheduler(
  run: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let scope: GatewaySchedulerScope | undefined;
  let scheduledSweep: Promise<void> | undefined;

  function startScheduledSweep(signal: AbortSignal) {
    if (scheduledSweep) {
      return scheduledSweep;
    }
    let admitted = false;
    scheduledSweep = runWithGatewayIndependentRootWorkAdmission(
      async () => {
        admitted = true;
        await run(signal);
      },
      "cron:maintenance",
      signal,
    )
      .catch((error: unknown) => {
        // A restart can refuse the tick before a sweep starts; admitted failures still need reporting.
        if (admitted || (!signal.aborted && !isGatewayRestartDrainError(error))) {
          onError(error);
        }
      })
      .finally(() => {
        scheduledSweep = undefined;
      });
    return scheduledSweep;
  }

  return {
    start: (scheduler: GatewayScheduler) => {
      if (scope && !scope.signal.aborted) {
        return;
      }
      scope = scheduler.scope();
      const { signal } = scope;
      scope.schedule({
        id: "cron-maintenance",
        delayMs: 5_000,
        everyMs: CRON_SWEEP_INTERVAL_MS,
        run: () => startScheduledSweep(signal),
      });
    },
    stop: async (): Promise<void> => {
      await Promise.all([scope?.stop(), scheduledSweep]);
    },
  };
}
