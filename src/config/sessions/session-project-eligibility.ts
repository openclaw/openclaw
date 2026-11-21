import { WORKSPACE_PROJECT_ID_PREFIX } from "../../projects/workspace-project-id.js";
import type { InternalSessionEntry } from "./types.js";

export function isUnboundProjectSession(
  entry: Partial<InternalSessionEntry>,
  agentId: string,
  workspaceDir: string,
): boolean {
  return !(
    entry.worktree ||
    entry.repositoryWorkspaceId ||
    (entry.projectId && entry.projectId !== `${WORKSPACE_PROJECT_ID_PREFIX}${agentId}`) ||
    entry.deviceFolder ||
    entry.execNode ||
    entry.pendingWorktree ||
    entry.pendingProjectGitUrl ||
    (entry.sessionRoot !== undefined && entry.sessionRoot !== workspaceDir)
  );
}
