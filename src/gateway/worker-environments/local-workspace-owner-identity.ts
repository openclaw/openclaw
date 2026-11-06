import type { LocalWorkspaceProjection } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export function assertLocalWorkspaceProjectionOwner(
  row: LocalWorkspaceProjection,
  owner: LocalWorkspaceOwner,
  projectionPath?: string,
) {
  if (
    row.worktree_id !== owner.worktree.id ||
    row.agent_id !== owner.agentId ||
    row.session_key !== owner.sessionKey ||
    row.session_id !== owner.sessionId ||
    row.lifecycle_revision !== owner.lifecycleRevision ||
    (projectionPath !== undefined && row.projection_path !== projectionPath)
  ) {
    throw new Error(
      "Local sandbox workspace belongs to a different session incarnation; pending edits were preserved",
    );
  }
}
