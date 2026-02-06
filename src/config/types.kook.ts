import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type KookDmConfig = {
  /** If false, ignore all incoming KOOK DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (ids or usernames). */
  allowFrom?: Array<string | number>;
  /** If true, allow group messages (default: false). */
  groupEnabled?: boolean;
  /** Optional allowlist for group channels (ids). */
  groupChannels?: Array<string | number>;
};

export type KookGuildChannelConfig = {
  allow?: boolean;
  requireMention?: boolean;
  /** Optional tool policy overrides for this channel. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this channel. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this channel. */
  enabled?: boolean;
  /** Optional allowlist for channel senders (ids or usernames). */
  users?: Array<string | number>;
  /** Optional system prompt snippet for this channel. */
  systemPrompt?: string;
};

export type KookGuildEntry = {
  slug?: string;
  requireMention?: boolean;
  /** Optional tool policy overrides for this guild (used when channel override is missing). */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  users?: Array<string | number>;
  channels?: Record<string, KookGuildChannelConfig>;
};

export type KookActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  memberInfo?: boolean;
  roleInfo?: boolean;
  roles?: boolean;
  channelInfo?: boolean;
  voiceStatus?: boolean;
  emojiList?: boolean;
  emojiUploads?: boolean;
  channels?: boolean;
  moderation?: boolean;
  guildInfo?: boolean;
};

export type KookAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides. */
  markdown?: MarkdownConfig;
  /** If false, do not start this KOOK account. Default: true. */
  enabled?: boolean;
  token?: string;
  /**
   * Controls how guild channel messages are handled:
   * - "open": guild channels bypass allowlists; mention-gating applies
   * - "disabled": block all guild channel messages
   * - "allowlist": only allow channels present in kook.guilds.*.channels
   */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 2000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Retry policy for outbound KOOK API calls. */
  retry?: OutboundRetryConfig;
  /** Per-action tool gating (default: true for all). */
  actions?: KookActionConfig;
  dm?: KookDmConfig;
  /** New per-guild config keyed by guild id. */
  guilds?: Record<string, KookGuildEntry>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type KookConfig = {
  /** Optional per-account KOOK configuration (multi-account). */
  accounts?: Record<string, KookAccountConfig>;
} & KookAccountConfig;
