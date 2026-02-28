import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
  ReplyToMode,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type TelegramActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
  /** Enable sticker actions (send and search). */
  sticker?: boolean;
  /** Enable forum topic creation. */
  createForumTopic?: boolean;
};

export type TelegramNetworkConfig = {
  /** Override Node's autoSelectFamily behavior (true = enable, false = disable). */
  autoSelectFamily?: boolean;
  /**
   * DNS result order for network requests ("ipv4first" | "verbatim").
   * Set to "ipv4first" to prioritize IPv4 addresses and work around IPv6 issues.
   * Default: "ipv4first" on Node 22+ to avoid common fetch failures.
   */
  dnsResultOrder?: "ipv4first" | "verbatim";
};

export type TelegramInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";
export type TelegramStreamingMode = "off" | "partial" | "block" | "progress";

export type TelegramCapabilitiesConfig =
  | string[]
  | {
      inlineButtons?: TelegramInlineButtonsScope;
    };

/** Custom command definition for Telegram bot menu. */
export type TelegramCustomCommand = {
  /** Command name (without leading /). */
  command: string;
  /** Description shown in Telegram command menu. */
  description: string;
};

export type TelegramAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: TelegramCapabilitiesConfig;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for Telegram (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Custom commands to register in Telegram's command menu (merged with native). */
  customCommands?: TelegramCustomCommand[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /**
   * Controls how Telegram direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /** If false, do not start this Telegram account. Default: true. */
  enabled?: boolean;
  botToken?: string;
  /** Path to file containing bot token (for secret managers like agenix). */
  tokenFile?: string;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  groups?: Record<string, TelegramGroupConfig>;
  /** DM allowlist (numeric Telegram user IDs). Onboarding can resolve @username to IDs. */
  allowFrom?: Array<string | number>;
  /** Default delivery target for CLI `--deliver` when no explicit `--reply-to` is provided. */
  defaultTo?: string | number;
  /** Optional allowlist for Telegram group senders (numeric Telegram user IDs). */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /**
   * Stream preview mode:
   * - "off": disable preview updates
   * - "partial": edit a single preview message
   * - "block": stream in larger chunked updates
   * - "progress": alias that maps to "partial" on Telegram
   *
   * Legacy boolean values are still accepted and auto-migrated.
   */
  streaming?: TelegramStreamingMode | boolean;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** @deprecated Legacy chunking config from `streamMode: "block"`; ignored after migration. */
  draftChunk?: BlockStreamingChunkConfig;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** @deprecated Legacy key; migrated automatically to `streaming`. */
  streamMode?: "off" | "partial" | "block";
  mediaMaxMb?: number;
  /** Telegram API client timeout in seconds (grammY ApiClientOptions). */
  timeoutSeconds?: number;
  /** Retry policy for outbound Telegram API calls. */
  retry?: OutboundRetryConfig;
  /** Network transport overrides for Telegram. */
  network?: TelegramNetworkConfig;
  proxy?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  /** Local webhook listener bind host (default: 127.0.0.1). */
  webhookHost?: string;
  /** Local webhook listener bind port (default: 8787). */
  webhookPort?: number;
  /** Per-action tool gating (default: true for all). */
  actions?: TelegramActionConfig;
  /**
   * Controls which user reactions trigger notifications:
   * - "off" (default): ignore all reactions
   * - "own": notify when users react to bot messages
   * - "all": notify agent of all reactions
   */
  reactionNotifications?: "off" | "own" | "all";
  /**
   * Controls agent's reaction capability:
   * - "off": agent cannot react
   * - "ack" (default): bot sends acknowledgment reactions (👀 while processing)
   * - "minimal": agent can react sparingly (guideline: 1 per 5-10 exchanges)
   * - "extensive": agent can react liberally when appropriate
   */
  reactionLevel?: "off" | "ack" | "minimal" | "extensive";
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Controls whether link previews are shown in outbound messages. Default: true. */
  linkPreview?: boolean;
  /**
   * Per-channel outbound response prefix override.
   *
   * When set, this takes precedence over the global `messages.responsePrefix`.
   * Use `""` to explicitly disable a global prefix for this channel.
   * Use `"auto"` to derive `[{identity.name}]` from the routed agent.
   */
  responsePrefix?: string;
  /**
   * Per-channel ack reaction override.
   * Telegram expects unicode emoji (e.g., "👀") rather than shortcodes.
   */
  ackReaction?: string;
};

export type TelegramTopicConfig = {
  requireMention?: boolean;
  /** Per-topic override for group message policy (open|disabled|allowlist). */
  groupPolicy?: GroupPolicy;
  /** If specified, only load these skills for this topic. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this topic. */
  enabled?: boolean;
  /** Optional allowlist for topic senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this topic. */
  systemPrompt?: string;
};

export type TelegramGroupConfig = {
  requireMention?: boolean;
  /** Per-group override for group message policy (open|disabled|allowlist). */
  groupPolicy?: GroupPolicy;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group (when no topic). Omit = all skills; empty = no skills. */
  skills?: string[];
  /** Per-topic configuration (key is message_thread_id as string) */
  topics?: Record<string, TelegramTopicConfig>;
  /** If false, disable the bot for this group (and its topics). */
  enabled?: boolean;
  /** Optional allowlist for group senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

export type TelegramConfig = {
  /** Optional per-account Telegram configuration (multi-account). */
  accounts?: Record<string, TelegramAccountConfig>;
} & TelegramAccountConfig;
