import { formatErrorMessage } from "../../infra/errors.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";
import { resolveGatewayShutdownBudget } from "./run-loop-shutdown-budget.js";
import {
  armShutdownHardExitWatchdog,
  type ShutdownHardExitWatchdog,
} from "./shutdown-hard-exit.js";

type ShutdownBudget = Awaited<ReturnType<typeof resolveGatewayShutdownBudget>>;

/** One queued startup request owns both deadlines, including async budget refreshes. */
export function createGatewayStartupWatchdog({
  startupBudget,
  supervisorMode,
  gatewayLog,
  ownsProcessLifecycle,
  hardExitGraceMs,
  retireWatchdog,
  retainCleanup,
  hasPendingRequest,
  reportBudget,
  onTimeout,
}: {
  startupBudget: ShutdownBudget;
  supervisorMode: string | null;
  gatewayLog: Pick<SubsystemLogger, "info" | "warn" | "error">;
  ownsProcessLifecycle: boolean | undefined;
  hardExitGraceMs: number;
  retireWatchdog: (watchdog: ShutdownHardExitWatchdog | null) => void;
  retainCleanup: (completion: Promise<void>) => void;
  hasPendingRequest: () => boolean;
  reportBudget: (budget: ShutdownBudget) => void;
  onTimeout: () => void;
}) {
  let pendingStartupForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStartupWatchdog: ShutdownHardExitWatchdog | null = null;
  const clearPendingStartupForceExitTimer = () => {
    clearTimeout(pendingStartupForceExitTimer ?? undefined);
    pendingStartupForceExitTimer = null;
    retireWatchdog(pendingStartupWatchdog);
    pendingStartupWatchdog = null;
  };
  const armPendingStartupForceExitTimer = (pendingRequest: GatewayRunSignalRequest) => {
    // Request admission already coalesces repeated signals before arming.
    reportBudget(startupBudget);
    const expire = () => {
      pendingStartupForceExitTimer = null;
      gatewayLog.error(
        "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
      );
      onTimeout();
    };
    const arm = (timeoutMs: number) => {
      const timer = setTimeout(expire, timeoutMs);
      timer.unref?.();
      pendingStartupForceExitTimer = timer;
      if (ownsProcessLifecycle) {
        retireWatchdog(pendingStartupWatchdog);
        pendingStartupWatchdog = armShutdownHardExitWatchdog({
          delayMs: timeoutMs + hardExitGraceMs,
          onError: (error) =>
            gatewayLog.warn(`startup hard-exit watchdog failed: ${formatErrorMessage(error)}`),
        });
      }
      return timer;
    };
    const timer = arm(startupBudget.timeoutMs);
    if (process.platform === "linux" || process.platform === "darwin") {
      retainCleanup(
        resolveGatewayShutdownBudget(supervisorMode, gatewayLog, {
          previous: startupBudget,
          acceptedAtMs: pendingRequest.acceptedAtMs,
        })
          .then((budget) => {
            // Update upgrades replace the request while retaining this watchdog.
            if (!hasPendingRequest() || pendingStartupForceExitTimer !== timer) {
              return;
            }
            reportBudget(budget);
            clearTimeout(timer);
            arm(budget.timeoutMs);
          })
          .catch((error: unknown) =>
            gatewayLog.warn(`Startup shutdown budget refresh failed: ${formatErrorMessage(error)}`),
          ),
      );
    }
  };
  return { arm: armPendingStartupForceExitTimer, clear: clearPendingStartupForceExitTimer };
}
