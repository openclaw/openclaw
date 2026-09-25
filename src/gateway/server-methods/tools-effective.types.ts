import type { ResolvedConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type TrustedToolsEffectiveContext = {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  runtimeConfigCacheKey: string;
  pluginRegistryVersion: number;
  channelRegistryVersion: number;
  nodePluginToolsVersion: number;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  spawnedBy?: string | null;
  agentHarnessId?: string;
  toolOverrides?: SessionToolOverrides;
};
