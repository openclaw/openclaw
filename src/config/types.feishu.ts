import type { DmPolicy, GroupPolicy, MarkdownConfig, OutboundRetryConfig } from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type FeishuGroupConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders (open_ids). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

export type FeishuAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Feishu app ID (cli_xxx). */
  appId?: string;
  /** Feishu app secret. */
  appSecret?: string;
  /** Path to file containing app secret (for secret managers). */
  appSecretFile?: string;
  /** API domain override: "feishu" (default), "lark" (global), or full https:// domain. */
  domain?: string;
  /** Bot display name (used for streaming card title). */
  botName?: string;
  /** If false, do not start this Feishu account. Default: true. */
  enabled?: boolean;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for Feishu (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /**
   * Controls how Feishu direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Allowlist for DM senders (open_id or union_id). */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for Feishu group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user open_id. */
  dms?: Record<string, DmConfig>;
  /** Per-group config keyed by chat_id (oc_xxx). */
  groups?: Record<string, FeishuGroupConfig>;
  /** Outbound text chunk size (chars). Default: 2000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /**
   * Enable streaming card mode for replies (shows typing indicator).
   * When true, replies are streamed via Feishu's CardKit API with typewriter effect.
   * Default: true.
   */
  streaming?: boolean;
  /** Media max size in MB. */
  mediaMaxMb?: number;
  /** Retry policy for outbound Feishu API calls. */
  retry?: OutboundRetryConfig;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type FeishuConfig = {
  /** Optional per-account Feishu configuration (multi-account). */
  accounts?: Record<string, FeishuAccountConfig>;
  /** Top-level app ID (alternative to accounts). */
  appId?: string;
  /** Top-level app secret (alternative to accounts). */
  appSecret?: string;
  /** Top-level app secret file (alternative to accounts). */
  appSecretFile?: string;
} & Omit<FeishuAccountConfig, "appId" | "appSecret" | "appSecretFile">;
