export type PromptBuildScopeEnvelope = {
  workspaceKind: "personal_workspace" | "topic_workspace" | "multi_user_shared_space";
  scopeOwner: "session" | "channel" | "thread" | "topic_kb" | "active_task";
  topicKey?: string;
  topicAliases?: string[];
  taskId?: string;
  statePath?: string;
  statusDocPath?: string;
};
