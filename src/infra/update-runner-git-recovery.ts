import { runCommandWithTimeout } from "../process/exec.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import type { UpdateRunResult, UpdateStepProgress } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Diagnostic storage must never replay or interrupt restoration. */
export function recordGitRollbackOutcome(params: {
  outcome: NonNullable<UpdateRunResult["rollbackOutcome"]>;
  progress?: UpdateStepProgress;
  root: string;
  steps: UpdateStepResult[];
}): void {
  try {
    params.progress?.onRollbackOutcome?.(params.outcome);
  } catch {
    params.steps.push({
      name: "rollback-outcome-recording",
      command: "",
      cwd: params.root,
      durationMs: 0,
      exitCode: 0,
      advisory: {
        kind: "recoverable-maintenance",
        message:
          "Rollback outcome could not be saved to update history; the direct update result retains it.",
      },
    });
  }
}

export async function readCurrentGitUpdateRecovery(
  root: string,
  timeoutMs = UPDATE_RUNNER_TIMEOUT_MS,
): Promise<UpdateRecovery> {
  const head = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs,
  }).catch(() => null);
  return verifyGitUpdateRecovery({ root, sha: head?.code === 0 ? head.stdout.trim() : null });
}
