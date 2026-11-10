/** Agent-workspace pseudo-projects use this id prefix; their root is the agent workspace itself. */
export const WORKSPACE_PROJECT_ID_PREFIX = "workspace:";

export function isWorkspaceProjectId(id: string): boolean {
  return id.startsWith(WORKSPACE_PROJECT_ID_PREFIX);
}
