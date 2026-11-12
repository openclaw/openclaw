import fs from "node:fs";
import path from "node:path";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isPathInside } from "../infra/path-guards.js";

/** A nested source workspace keeps its relative cwd inside the new checkout. */
export function prepareSessionWorktreeCwd(
  worktreePath: string,
  sourceRoot: string | undefined,
  workspace: string | undefined,
): string {
  const relative =
    sourceRoot && workspace ? path.relative(sourceRoot, fs.realpathSync(workspace)) : "";
  const nestedCwd = path.resolve(worktreePath, relative);
  if (relative && isPathInside(worktreePath, nestedCwd)) {
    fs.mkdirSync(nestedCwd, { recursive: true });
    return nestedCwd;
  }
  return worktreePath;
}

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
