import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("boards/store");

export function reportBoardCleanupFailure(error: unknown) {
  try {
    log.warn(`Board publication completed before cleanup failed: ${formatErrorMessage(error)}`);
  } catch {
    // The resource owner retains cleanup; diagnostics cannot reverse a committed result.
  }
}
