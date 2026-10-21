import fs from "node:fs/promises";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { formatErrorMessage } from "./errors.js";
import { trimLogTail } from "./restart-sentinel.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { formatUpdateCleanupCommand } from "./update-maintenance.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { MAX_LOG_CHARS, runStep } from "./update-runner-command.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import type { CommandRunner, UpdateRunResult } from "./update-runner-types.js";

const PREFLIGHT_CLEANUP_TIMEOUT_MS = 60_000;

/** Only reporting failed; no runtime or process-settlement verdict is implied. */
export class GitCleanupReportingError extends AggregateError {
  constructor(primary: unknown, reportingFailures: unknown[]) {
    super([primary, ...reportingFailures], "Git update and cleanup reporting failed", {
      cause: primary,
    });
  }
}

async function reportCleanupProgress(
  report: () => void | Promise<void>,
  onReportingError: (error: unknown) => void,
) {
  try {
    await report();
  } catch (error) {
    // Closed forward reporting does not revoke this temporary worktree's cleanup.
    const refusal = error instanceof Error ? error.cause : undefined;
    if (hasCommandProcessCleanupError(error) || error instanceof AggregateError) {
      throw error;
    }
    if (
      !(
        error instanceof UpdateRequesterRevokedError ||
        refusal instanceof UpdateRequesterRevokedError
      )
    ) {
      onReportingError(error);
    }
  }
}

async function repairPreflightCleanup(worktreeDir: string, preflightRoot: string) {
  try {
    await fs.rm(worktreeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await fs.rm(preflightRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

export async function cleanupGitPreflight(
  params: {
    gitRoot: string;
    step: StepFactory;
    runCommand: CommandRunner;
    onCleanupReportingError?: (error: unknown) => void;
  },
  worktreeDir: string,
  preflightRoot: string,
) {
  const options = {
    ...params.step(
      "preflight-cleanup",
      ["git", "-C", params.gitRoot, "worktree", "remove", "--force", "--force", worktreeDir],
      params.gitRoot,
    ),
    runCommand: params.runCommand,
  };
  const reportingFailures: unknown[] = [];
  const onReportingError = (error: unknown) => {
    reportingFailures.push(error);
    params.onCleanupReportingError?.(error);
  };
  // Cancellation ends candidate work, not cleanup of the worktree and its Git metadata.
  // Keep cleanup commands in the owned process tree with their existing bounded budget.
  const cleanupSignal = new AbortController().signal;
  const cleanupTimeoutMs = Math.min(
    options.timeoutMs ?? PREFLIGHT_CLEANUP_TIMEOUT_MS,
    PREFLIGHT_CLEANUP_TIMEOUT_MS,
  );
  const runCleanupCommand: CommandRunner = (argv, commandOptions) =>
    options.runCommand(argv, {
      ...commandOptions,
      signal: cleanupSignal,
      timeoutMs: cleanupTimeoutMs,
    });
  // Interrupted creation can retain Git's initialization lock. This exact temporary
  // worktree is owned here, so force twice instead of leaving a stale registration.
  const removeStep = await runStep({
    ...options,
    progress: {
      ...options.progress,
      onStepStart: (step) =>
        reportCleanupProgress(() => options.progress?.onStepStart?.(step), onReportingError),
      onStepComplete: undefined,
    },
    runCommand: runCleanupCommand,
    timeoutMs: cleanupTimeoutMs,
  });
  if (removeStep.exitCode !== 0 && (await repairPreflightCleanup(worktreeDir, preflightRoot))) {
    removeStep.exitCode = 0;
    const message =
      process.platform === "win32"
        ? "windows fallback cleanup removed preflight tree"
        : "fallback cleanup removed preflight tree";
    removeStep.stderrTail = trimLogTail(
      [removeStep.stderrTail, message].filter(Boolean).join("\n"),
      MAX_LOG_CHARS,
    );
  }
  await runCleanupCommand(["git", "-C", options.cwd, "worktree", "prune"], {
    cwd: options.cwd,
  }).catch((error: unknown) => {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return null;
  });
  const removed = await fs
    .rm(preflightRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    .then(
      () => true,
      (error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        if (removeStep.exitCode === 0) {
          removeStep.exitCode = 1;
        }
        removeStep.stderrTail = trimLogTail(
          [removeStep.stderrTail, formatErrorMessage(error)].filter(Boolean).join("\n"),
          MAX_LOG_CHARS,
        );
        return false;
      },
    );
  if (removeStep.exitCode !== 0) {
    removeStep.advisory = {
      kind: "recoverable-maintenance",
      message: `Skipped preflight cleanup. Remove the retained temporary copy with: ${formatUpdateCleanupCommand(preflightRoot)}. Reason: ${removeStep.stderrTail || "temporary worktree removal failed"}`,
    };
  }
  await reportCleanupProgress(
    () =>
      options.progress?.onStepComplete?.({
        ...removeStep,
        index: options.stepIndex,
        total: options.totalSteps,
      }),
    onReportingError,
  );
  if (reportingFailures.length > 0) {
    // Reporting is not runtime verification and cannot revoke private scratch cleanup.
    options.results?.push({
      name: "preflight-cleanup-reporting",
      command: "",
      cwd: options.cwd,
      durationMs: 0,
      exitCode: 0,
      advisory: {
        kind: "recoverable-maintenance",
        message: "Preflight cleanup reporting failed; cleanup was still attempted.",
      },
      failureFacts: reportingFailures.map((error) =>
        createUpdateErrorFact("preflight-cleanup-reporting", error, options.env),
      ),
    });
  }
  return removed;
}

/** Settle owned artifacts before exposing either the update result or its failure. */
export async function settleGitUpdateCleanup(
  update: () => Promise<UpdateRunResult>,
  cleanup: () => Promise<void>,
  reportingFailures: unknown[],
): Promise<UpdateRunResult> {
  let outcome: { result: UpdateRunResult } | { error: unknown };
  try {
    outcome = { result: await update() };
  } catch (error) {
    outcome = { error };
  }
  // Do not use an async finally: its rejection would erase the initiating failure.
  let cleanupFailure: { cause: unknown } | undefined;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = { cause: error };
  }
  if (cleanupFailure) {
    if ("error" in outcome) {
      throw new AggregateError(
        [outcome.error, ...reportingFailures, cleanupFailure.cause],
        "Git update and cleanup failed",
        { cause: outcome.error },
      );
    }
    throw cleanupFailure.cause;
  }
  if ("error" in outcome) {
    if (reportingFailures.length > 0) {
      throw new GitCleanupReportingError(outcome.error, reportingFailures);
    }
    throw outcome.error;
  }
  return outcome.result;
}
