import { getCurrentSessionControllerOwner } from "./session-controller.lifecycle.js";
import { assertSessionControllerOperation } from "./session-controller.state.js";

/**
 * Compaction owns semantic progress while it runs, so its bounded wait lives on
 * the existing controller watchdog instead of an independent liveness record.
 * The wait expires with the compaction safety ceiling, after which normal
 * staleness classification and recovery resume.
 */
export function withCompactionWatchdogAllowance<T>(
  params: { deadlineAtMs: number },
  run: () => Promise<T>,
): Promise<T> {
  const operation = getCurrentSessionControllerOwner();
  if (!operation) {
    return run();
  }
  const wait = operation.watchdog.beginWait({
    kind: "compaction",
    deadlineAtMs: params.deadlineAtMs,
    isCurrent: () => {
      assertSessionControllerOperation(operation);
      return true;
    },
  });
  operation.watchdog.progress("semantic", "compaction:started");
  return run().finally(() => {
    wait.close();
    operation.watchdog.progress("semantic", "compaction:ended");
  });
}
