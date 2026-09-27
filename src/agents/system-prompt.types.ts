// Prompt rendering modes shared across system-prompt builders and config.
export type PromptMode = "full" | "minimal" | "none";
export type SilentReplyPromptMode = "generic" | "none";

export type SystemPromptRuntimeInfo = {
  agentId?: string;
  agentName?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionUrl?: string;
  gitCoauthorPrompt?: string;
  host?: string;
  os?: string;
  arch?: string;
  node?: string;
  model?: string;
  defaultModel?: string;
  shell?: string;
  channel?: string;
  chatType?: string;
  capabilities?: string[];
  repoRoot?: string;
  activeNode?: string;
  activeNodeIdentity?: "requester" | "unknown";
};
