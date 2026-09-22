import fs from "node:fs/promises";
import { trimLogTail } from "./restart-sentinel.js";
import { formatUpdateCleanupCommand } from "./update-maintenance.js";
import { MAX_LOG_CHARS, runStep } from "./update-runner-command.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";

const PREFLIGHT_CLEANUP_TIMEOUT_MS = 60_000;

async function removePathRecursive(target: string) {
  await fs
    .rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    .catch(() => {});
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
  options: RunStepOptions,
  worktreeDir: string,
  preflightRoot: string,
) {
  // Cancellation ends candidate work, not cleanup of the worktree and its Git metadata.
  // Keep cleanup commands in the owned process tree with their existing bounded budget.
  const cleanupSignal = new AbortController().signal;
  const cleanupTimeoutMs = Math.min(options.timeoutMs, PREFLIGHT_CLEANUP_TIMEOUT_MS);
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
    progress: { ...options.progress, onStepComplete: undefined },
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
  if (removeStep.exitCode !== 0) {
    removeStep.advisory = {
      kind: "recoverable-maintenance",
      message: `Skipped preflight cleanup. Remove the retained temporary copy with: ${formatUpdateCleanupCommand(preflightRoot)}. Reason: ${removeStep.stderrTail || "temporary worktree removal failed"}`,
    };
  }
  await runCleanupCommand(["git", "-C", options.cwd, "worktree", "prune"], {
    cwd: options.cwd,
  }).catch(() => null);
  await removePathRecursive(preflightRoot);
  options.progress?.onStepComplete?.({
    ...removeStep,
    index: options.stepIndex,
    total: options.totalSteps,
  });
}
