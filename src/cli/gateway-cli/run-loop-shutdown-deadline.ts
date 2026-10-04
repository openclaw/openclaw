import { performance } from "node:perf_hooks";
import {
  armShutdownHardExitWatchdog,
  type ShutdownHardExitWatchdog,
} from "./shutdown-hard-exit.js";

/** The run loop's single main-thread deadline and process-owned hard-exit watchdog. */
export function createGatewayShutdownDeadline(params: {
  ownsProcessLifecycle: boolean;
  hardExitGraceMs: number;
  canArm: () => boolean;
  onTimeout: () => void;
  onWatchdogError: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  let watchdog: ShutdownHardExitWatchdog | null = null;
  return {
    get armed() {
      return timer !== undefined;
    },
    get deadline() {
      return deadline;
    },
    arm: (timeoutMs: number) => {
      if (timer !== undefined || !params.canArm()) {
        return;
      }
      deadline = performance.now() + timeoutMs;
      timer = setTimeout(params.onTimeout, timeoutMs);
      if (params.ownsProcessLifecycle) {
        watchdog = armShutdownHardExitWatchdog({
          delayMs: timeoutMs + params.hardExitGraceMs,
          onError: params.onWatchdogError,
        });
      }
    },
    clear: () => {
      clearTimeout(timer);
      timer = undefined;
      deadline = undefined;
      watchdog?.cancel();
      watchdog = null;
    },
  };
}
