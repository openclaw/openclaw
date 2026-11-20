import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import { runPublicationCommand } from "./github-publication-git-transport.js";

/**
 * Picks the PR base branch from a worktree's recorded base. A worktree created from an
 * abbreviated commit ID records that text, which names a commit rather than a branch the PR
 * can target, so it selects the default branch like a full commit ID does. A local or origin
 * branch with the same name still wins, as it did when the worktree was created.
 */
export async function resolveRecordedPublicationBaseBranch(
  cwd: string,
  baseRef: string,
  defaultBranch: string,
): Promise<string> {
  const trimmed = baseRef.trim();
  if (!/^[0-9a-f]{4,63}$/iu.test(trimmed)) {
    return parseGitHubPublicationBaseBranch(baseRef, defaultBranch);
  }
  for (const ref of [`refs/heads/${trimmed}`, `refs/remotes/origin/${trimmed}`]) {
    const branch = await runPublicationCommand(["git", "show-ref", "--verify", "--quiet", ref], {
      cwd,
    });
    if (branch.code === 0) {
      return parseGitHubPublicationBaseBranch(baseRef, defaultBranch);
    }
  }
  const commit = await runPublicationCommand(
    ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", `${trimmed}^{commit}`],
    { cwd },
  );
  const id = commit.code === 0 ? commit.stdout.toString("utf8").trim().toLowerCase() : "";
  return id.startsWith(trimmed.toLowerCase())
    ? defaultBranch
    : parseGitHubPublicationBaseBranch(baseRef, defaultBranch);
}
