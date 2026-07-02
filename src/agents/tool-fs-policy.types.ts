/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsWorkspaceAlias = {
  path: string;
  target: string;
};

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  workspaceAliases?: readonly ToolFsWorkspaceAlias[];
};
