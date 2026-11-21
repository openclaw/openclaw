import type { InternalSessionEntry } from "./types.js";

export function isUnboundProjectSession(
  entry: Partial<InternalSessionEntry>,
  workspaceDir: string,
): boolean {
  return !(
    entry.worktree ||
    entry.repositoryWorkspaceId ||
    entry.projectId ||
    entry.deviceFolder ||
    entry.execNode ||
    entry.pendingWorktree ||
    entry.pendingProjectGitUrl ||
    (entry.sessionRoot !== undefined && entry.sessionRoot !== workspaceDir)
  );
}
