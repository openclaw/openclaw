import type { DmPolicy, GroupPolicy, MarkdownConfig, OutboundRetryConfig } from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type DingTalkGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type DingTalkAccountConfig = {
  name?: string;
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  markdown?: MarkdownConfig;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  groups?: Record<string, DingTalkGroupConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  streaming?: boolean;
  mediaMaxMb?: number;
  responsePrefix?: string;
  retry?: OutboundRetryConfig;
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  systemPrompt?: string;
  sessionTimeoutMs?: number;
  aiCardTemplateId?: string;
  debug?: boolean;
};

export type DingTalkConfig = {
  accounts?: Record<string, DingTalkAccountConfig>;
} & DingTalkAccountConfig;
