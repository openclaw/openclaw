import fs from "node:fs/promises";
import path from "node:path";
import {
  commandError,
  listGitWorktrees,
  worktreePathExists,
  requireGit,
  runGit,
  type GitResult,
} from "./git.js";

export async function resetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  rollbackGuard: () => void,
): Promise<void> {
  const options = { beforeRun: rollbackGuard, killProcessTree: true };
  const listed = (await listGitWorktrees(repoRoot, options)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed) {
    const removed = await runGit(
      repoRoot,
      ["worktree", "remove", "--force", worktreePath],
      options,
    );
    if (removed.code !== 0) {
      throw commandError("git worktree remove", removed);
    }
  } else if (await worktreePathExists(worktreePath)) {
    // A failed add can leave an unregistered directory; it is safe debris once git omits it.
    rollbackGuard();
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  const branchExists = await runGit(
    repoRoot,
    ["show-ref", "--quiet", "--verify", `refs/heads/${branch}`],
    options,
  );
  if (branchExists.code === 0) {
    await requireGit(repoRoot, ["branch", "-D", branch], options);
  }
}

export async function canResetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  failure: GitResult,
): Promise<boolean> {
  // Keep retry evidence unchanged: diagnostic rendering/truncation must never
  // grant cleanup or retry authority.
  const message = (failure.stderr || failure.stdout).trim().split("\n").slice(-12).join("\n");
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await worktreePathExists(worktreePath))) {
    return false;
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  return branchExists.code === 1;
}
