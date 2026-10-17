import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "./subagents/announce/subagent-announce-handoff.js";

export type WebSearchToolPolicyParams = {
  webSearchEnabled?: boolean;
  config?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  inputProvenance?: InputProvenance;
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  runtimeToolAllowlist?: string[];
  preparedRequesterPolicy?: {
    delegated: boolean;
    groupPolicy?: SandboxToolPolicy;
    senderPolicy?: SandboxToolPolicy;
    subagentPolicy?: SandboxToolPolicy;
    inheritedToolPolicy?: SandboxToolPolicy;
  };
};

export type WebSearchToolPolicyResolution = {
  allowed: boolean;
  persistentAllowed: boolean;
};
