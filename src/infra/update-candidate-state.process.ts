import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { formatErrorMessageWithCode } from "./errors.js";
import {
  emitSnapshotCleanupFailure,
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  retainSnapshotWork,
} from "./sqlite-readonly-location-cleanup.js";

/** A bounded command result does not release snapshot ownership before late process cleanup. */
export function withUpdateStateInspectionWork<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let stop = () => {};
  const work = withCommandProcessScope((stopScope) => {
    stop = stopScope;
    return run();
  }, signal);
  return retainSnapshotWork(work, () => stop());
}

export async function withStateInspectionCleanup<T>(
  stagingRoot: string,
  inspect: () => Promise<T>,
  options: { cleanupFailure?: "warn" } = {},
): Promise<T> {
  let outcome: { value: T } | { cause: unknown };
  try {
    outcome = { value: await inspect() };
  } catch (cause) {
    outcome = { cause };
  }
  if ("cause" in outcome && hasCommandProcessCleanupError(outcome.cause)) {
    // Command settlement failed. Keep the bytes for the existing snapshot
    // reclaimer instead of registering another exit/signal deletion attempt.
    releaseSnapshotTempDirectory(stagingRoot);
    throw new Error(
      `${formatErrorMessageWithCode(outcome.cause)}. Staging retained at ${stagingRoot}. Confirm that update workers have stopped before retrying the update.`,
      { cause: outcome.cause },
    );
  }
  const removed = removeTempDirectory(stagingRoot, (error) => {
    if (options.cleanupFailure === "warn") {
      emitSnapshotCleanupFailure({
        cleanupRoot: stagingRoot,
        operation: "rm",
        code: extractErrorCode(error),
      });
    }
  });
  if (!removed && options.cleanupFailure !== "warn") {
    throw new Error(`State schema inspection snapshot cleanup failed: ${stagingRoot}`, {
      cause: "cause" in outcome ? outcome.cause : undefined,
    });
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}
