import { isAbortError } from "../infra/abort-signal.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
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
  run: (signal: AbortSignal) => Promise<void>;
  log: { warn: (message: string) => void };
  errorMessage: string;
}): GatewayIdleTaskHandle {
  const scheduler = params.scheduler.scope();
  const isClosing = () =>
    scheduler.signal.aborted || params.isClosing() || getGatewayRestartDrainSignal().aborted;
  const schedule = (delayMs: number) => {
    if (isClosing()) {
      return;
    }
    scheduler.schedule({
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
        return admission
          .run(() =>
            params.run(AbortSignal.any([scheduler.signal, getGatewayRestartDrainSignal()])),
          )
          .then(() => {
            if (params.repeatDelayMs !== undefined) {
              schedule(params.repeatDelayMs);
            }
          })
          .catch((error: unknown) => {
            if (
              !isGatewayRestartDrainError(error) &&
              !(scheduler.signal.aborted && isAbortError(error))
            ) {
              params.log.warn(`${params.errorMessage}: ${String(error)}`);
            }
          })
          .finally(() => {
            admission.release();
          });
      },
    });
  };
  schedule(params.delayMs);
  return {
    stop: scheduler.stop,
  };
}
