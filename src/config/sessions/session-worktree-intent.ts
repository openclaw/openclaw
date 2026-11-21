import type { InternalSessionEntry } from "./types.js";

/** Private source selection accepted under the session creation lifecycle lock. */
export type PendingSessionWorktree = {
  workspace?: string;
  /** Source custody accepted by the locked creation owner, not public request input. */
  source?: { kind: "project" | "worktree"; id: string };
  name?: string;
  baseRef?: string;
  /** Verified commit used for checkout while baseRef remains user-facing metadata. */
  baseCommit?: string;
  titleSource: string;
  /** A moved conversation's checkout work, held under `ref` in the project repository. */
  carried?: { ref: string; work: string };
  /** A moved conversation's earlier files, kept readable for its earlier messages. */
  prior?: {
    workspaceDir: string;
    fileRoot: string;
    through: { generation: string | null; maxSeq: number | null };
  };
};

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
