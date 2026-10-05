import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import { markGatewayRestartTrace, measureGatewayRestartTrace } from "./restart-trace.js";
import { recordGatewayShutdownWarning as recordShutdownWarning } from "./server-shutdown.js";
const shutdownLog = createSubsystemLogger("gateway/shutdown");
export function createCloseStepTimer(reason: string) {
  return <T>(name: string, run: () => Promise<T> | T) => {
    markGatewayRestartTrace(`restart.close.${name}.begin`);
    return measureGatewayRestartTrace(`restart.close.${name}`, run, [["reason", reason]]);
  };
}

/** Run one shutdown step and record a warning instead of aborting the whole close. */
export async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    if (hasRetainedPluginRuntimeCloseError(err)) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${name}: ${detail}`);
    recordShutdownWarning(warnings, name);
    return false;
  }
}
