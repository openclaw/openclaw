import fs from "node:fs/promises";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { formatErrorMessage } from "./errors.js";
import type { UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

const TEMPORARY_COPY_CLEANUP_BUDGET_MS = 5 * 60_000;

export function formatUpdateCleanupCommand(directory: string): string {
  return process.platform === "win32"
    ? `Remove-Item -LiteralPath ${quotePowerShellArg(directory)} -Recurse -Force`
    : `rm -rf -- ${quoteCliArg(directory)}`;
}

/** Only disposable directories owned by this update, never recovery originals. */
export async function cleanupUpdateTemporaryDirectory(params: {
  directory: string;
  root: string;
  name: string;
  /** Recheck custody inside the warning boundary; false skips removal. */
  canRemove?: () => Promise<boolean>;
  onProgress?: (step: UpdateRunStep) => void;
  onWarning: (step: UpdateStepResult) => void;
}): Promise<void> {
  const started = Date.now();
  const monotonicDeadline = performance.now() + TEMPORARY_COPY_CLEANUP_BUDGET_MS;
  const recordProgress = (reason: string, completed = false) =>
    params.onProgress?.({
      step: params.name,
      status: completed ? "completed" : "in_progress",
      startedAtMs: started,
      ...(completed ? { endedAtMs: Date.now(), exitCode: 0 } : {}),
      detail: `Temporary-copy cleanup ${params.directory}; ${reason}; budget=${TEMPORARY_COPY_CLEANUP_BUDGET_MS}ms (5 minutes for large copies on slow disks); deadline=${new Date(started + TEMPORARY_COPY_CLEANUP_BUDGET_MS).toISOString()}.`,
    });
  recordProgress(
    `waiting for ${params.canRemove ? "directory custody verification" : "filesystem removal"}`,
  );
  let canRemove = false;
  let expired = false;
  let failure: string | undefined;
  try {
    expired =
      (await awaitWithinDeadline(
        async () => {
          const owned = !params.canRemove || (await params.canRemove());
          // A late custody result cannot start deletion after this owner stopped waiting.
          if (!owned || expired || performance.now() >= monotonicDeadline) {
            return;
          }
          canRemove = true;
          if (params.canRemove) {
            recordProgress("waiting for filesystem removal");
          }
          await fs.rm(params.directory, { recursive: true, force: true });
        },
        monotonicDeadline,
        () => performance.now(),
      )) === ABSOLUTE_DEADLINE_EXPIRED;
  } catch (error) {
    failure = formatErrorMessage(error);
  }
  if (canRemove && failure === undefined && !expired) {
    recordProgress("removed disposable temporary copy", true);
    return;
  }
  // Unverified paths may be absent or replaced; never recommend deleting them.
  const command = canRemove ? formatUpdateCleanupCommand(params.directory) : "";
  const reason = expired
    ? `Temporary-copy cleanup budget expired after ${TEMPORARY_COPY_CLEANUP_BUDGET_MS}ms.`
    : (failure ?? "Directory ownership could not be verified.");
  params.onWarning({
    name: params.name,
    command,
    cwd: params.root,
    durationMs: Date.now() - started,
    exitCode: expired ? null : 1,
    ...(expired ? { termination: "timeout" as const } : {}),
    stderrTail: reason,
    advisory: {
      kind: "recoverable-maintenance",
      message: canRemove
        ? expired
          ? // fs.rm cannot be cancelled; only this invocation's disposable copy remains in flight.
            `Stopped waiting for ${params.name}. Temporary-copy removal may still be finishing. If ${params.directory} remains after the updater exits, remove it with: ${command}. Reason: ${reason}`
          : `Skipped ${params.name}. Remove the retained temporary copy with: ${command}. Reason: ${reason}`
        : `Skipped ${params.name}: ownership could not be verified for ${params.directory}. Inspect that path before removing any files.${failure !== undefined || expired ? ` Reason: ${reason}` : ""}`,
    },
  });
}
