import fs from "node:fs/promises";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { formatErrorMessage } from "./errors.js";
import { trimLogTail } from "./restart-sentinel.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { formatUpdateCleanupCommand } from "./update-maintenance.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { MAX_LOG_CHARS, runStep } from "./update-runner-command.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import type { CommandRunner } from "./update-runner-types.js";

const PREFLIGHT_CLEANUP_TIMEOUT_MS = 60_000;

async function reportCleanupProgress(
  report: () => void | Promise<void>,
  warnings: string[],
  env?: NodeJS.ProcessEnv,
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
      const warning = `Preflight cleanup reporting failed: ${createUpdateErrorFact("preflight-cleanup", error, env).message}`;
      warnings.push(warning);
      console.warn(warning);
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
    defaultCommandEnv?: NodeJS.ProcessEnv;
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
  const warnings: string[] = [];
  const env = options.env
    ? { ...params.defaultCommandEnv, ...options.env }
    : params.defaultCommandEnv;
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
        reportCleanupProgress(() => options.progress?.onStepStart?.(step), warnings, env),
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
    warnings,
    env,
  );
  if (warnings.length > 0) {
    removeStep.warnings = [...(removeStep.warnings ?? []), ...warnings];
  }
  return removed;
}
