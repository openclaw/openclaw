import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessageWithCode } from "./errors.js";
import {
  emitSnapshotCleanupFailure,
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  retainSnapshotWork,
} from "./sqlite-readonly-location-cleanup.js";
import { isSqliteSnapshotStagingName } from "./sqlite-snapshot-retirement.js";

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

function removeInterruptedInspectionDirectories(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(directory, entry.name);
    removeInterruptedInspectionDirectories(child);
    if (isSqliteSnapshotStagingName(entry.name)) {
      try {
        // Joined inspection workers can die between mkdir and token creation.
        // Nonrecursive removal touches no payload or native ownership token.
        fs.rmdirSync(child);
      } catch (error) {
        if (!hasErrnoCode(error, "ENOTEMPTY") && !hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
      }
    }
  }
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
  const onFailure = (error: unknown) => {
    if (options.cleanupFailure === "warn") {
      emitSnapshotCleanupFailure({
        cleanupRoot: stagingRoot,
        operation: "rm",
        code: extractErrorCode(error),
      });
    }
  };
  let removed = false;
  try {
    if (fs.existsSync(stagingRoot)) {
      removeInterruptedInspectionDirectories(stagingRoot);
    }
    removed = removeTempDirectory(stagingRoot, onFailure);
  } catch (error) {
    onFailure(error);
  }
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
