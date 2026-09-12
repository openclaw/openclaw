import fs from "node:fs/promises";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { WorktreeRepositoryError } from "./errors.js";
import { insideGitCheckout, runGit } from "./git.js";

export async function resolveCheckoutRootFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<string> {
  const rootResult = await runGit(requested, [
    "rev-parse",
    "--show-toplevel",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (rootResult.code !== 0) {
    if (rootResult.termination === "exit" && rootResult.stdout.trim()) {
      throw new WorktreeRepositoryError(
        `git checkout has no commits: ${requestedLabel}. Create an initial commit, then retry.`,
      );
    }
    if (insideGitCheckout(requested)) {
      throw new Error(
        `Git metadata is unavailable for ${requested}; checkout preserved. Restore the original repository metadata, then use git worktree repair from that repository. Do not recreate its index or delete the checkout to bypass recovery.`,
      );
    }
    throw new WorktreeRepositoryError(`not a git checkout: ${requestedLabel}`);
  }
  const output = rootResult.stdout.replace(/\n$/, "");
  const separator = output.lastIndexOf("\n");
  const root = separator < 0 ? "" : output.slice(0, separator);
  if (!root) {
    throw new WorktreeRepositoryError(`not a git checkout: ${requestedLabel}`);
  }
  return await fs.realpath(normalizeGitPathForFilesystem(root));
}
