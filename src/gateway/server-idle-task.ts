import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

export type GatewayIdleTaskHandle = {
  stop: () => void | Promise<void>;
};

/** Runs low-priority work while idle, optionally repeating after completed passes. */
export function scheduleGatewayIdleTask(params: {
  id: string;
  scheduler: GatewayScheduler;
  delayMs: number;
  retryDelayMs: number;
  repeatDelayMs?: number;
  isClosing: () => boolean;
  isBusy: () => boolean;
  run: () => Promise<void>;
  log: { warn: (message: string) => void };
  errorMessage: string;
}): GatewayIdleTaskHandle {
  const { scheduler } = params;
  let stopped = false;
  let job: GatewayScheduledJob | undefined;
  let running: Promise<void> | undefined;
  const isClosing = () => stopped || params.isClosing() || getGatewayRestartDrainSignal().aborted;
  const run = async () => {
    if (isClosing()) {
      return;
    }
    // Newly admitted request work takes priority over maintenance.
    if (params.isBusy()) {
      schedule(params.retryDelayMs);
    } else {
      await params.run();
      if (params.repeatDelayMs !== undefined) {
        schedule(params.repeatDelayMs);
      }
    }
  };
  const schedule = (delayMs: number) => {
    if (isClosing()) {
      return;
    }
    job = scheduler.schedule({
      id: params.id,
      delayMs,
      run: () => {
        if (isClosing()) {
          return undefined;
        }
        // Optional work retries admission instead of waiting behind a suspend fence
        // that shutdown may never reopen.
        const admission = params.isBusy()
          ? null
          : tryBeginGatewayIndependentRootWorkAdmission("idle-task");
        if (!admission) {
          schedule(params.retryDelayMs);
          return undefined;
        }
        // Publish the join before callbacks can synchronously initiate shutdown.
        running = Promise.resolve()
          .then(() => admission.run(run))
          .catch((error: unknown) => {
            if (!isGatewayRestartDrainError(error)) {
              params.log.warn(`${params.errorMessage}: ${String(error)}`);
            }
          })
          .finally(() => {
            admission.release();
            running = undefined;
          });
        return running;
      },
    });
  };
  schedule(params.delayMs);
  return {
    stop: () => {
      stopped = true;
      job?.cancel();
      return running;
    },
  };
}
