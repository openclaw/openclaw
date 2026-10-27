import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";

/** Restore service custody only after update and Doctor commands have settled. */
export async function settleUpdateDoctorMaintenance<T extends object>(
  outcome: T | { error: unknown },
  restore: () => Promise<void>,
  release: () => Promise<void>,
  failureMessage: string,
): Promise<T | { error: unknown }> {
  const failures = "error" in outcome ? [outcome.error] : [];
  for (const operation of [restore, release]) {
    if (failures.some(hasCommandProcessCleanupError)) {
      break;
    }
    try {
      await withCommandProcessScope(operation);
    } catch (error) {
      if (!failures.includes(error)) {
        failures.push(error);
      }
    }
  }
  return failures.length
    ? {
        error:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, failureMessage, { cause: failures[0] }),
      }
    : outcome;
}
