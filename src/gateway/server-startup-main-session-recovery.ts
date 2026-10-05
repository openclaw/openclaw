import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";

const loadMainSessionRestartRecoveryModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery.js"),
);

/**
 * Schedules startup main-session restart recovery. A boot that started with the
 * crash-loop breaker tripped only marks interrupted sessions: replaying the turn
 * that crashed the previous process would keep the loop going.
 */
export async function scheduleStartupMainSessionRecovery(params: {
  crashLoopBreakerTripped?: boolean;
  getConfig: () => OpenClawConfig;
  isClosing?: () => boolean;
  log: { warn: (msg: string) => void };
  recoveryRuntime: GatewayRecoveryRuntime;
  startupCheckedStorePaths: Set<string>;
  waitForPostReadyWork?: () => Promise<void>;
}): Promise<GatewayPostReadySidecarHandle | undefined> {
  try {
    const { scheduleRestartAbortedMainSessionRecovery } =
      await loadMainSessionRestartRecoveryModule();
    if (params.isClosing?.() === true) {
      return undefined;
    }
    return scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      getConfig: params.getConfig,
      shouldContinue: () => params.isClosing?.() !== true,
      startupCheckedStorePaths: params.startupCheckedStorePaths,
      waitForStart: params.waitForPostReadyWork,
      gatewayRuntime: params.recoveryRuntime,
      ...(params.crashLoopBreakerTripped ? { pauseAutomaticDispatch: true } : {}),
    });
  } catch (err) {
    params.log.warn(`main-session restart recovery failed to schedule: ${String(err)}`);
    return undefined;
  }
}
