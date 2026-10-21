import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** A new workspace starts unbound; reuse retains the original PR on that exact workspace. */
export function createSessionWorktreeBinding(
  worktree: Pick<ManagedWorktreeRecord, "id" | "branch" | "repoRoot">,
  canonicalWorkspaceDir: string | undefined,
  previous?: SessionEntry["worktree"],
): NonNullable<SessionEntry["worktree"]> {
  return {
    id: worktree.id,
    branch: worktree.branch,
    repoRoot: worktree.repoRoot,
    canonicalWorkspaceDir,
    ...(previous?.id === worktree.id && previous.githubPullRequest
      ? { githubPullRequest: previous.githubPullRequest }
      : {}),
  };
}
