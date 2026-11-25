import { runCommandWithTimeout } from "../process/exec.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

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
