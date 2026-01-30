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

/**
 * Action configuration for Telegram GramJS user account adapter.
 */
export type TelegramGramJSActionConfig = {
  sendMessage?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
  forwardMessage?: boolean;
  reactions?: boolean;
};

/**
 * Capabilities configuration for Telegram GramJS adapter.
 */
export type TelegramGramJSCapabilitiesConfig =
  | string[]
  | {
      inlineButtons?: boolean;
      reactions?: boolean;
      secretChats?: boolean; // Future: Phase 3
    };

/**
 * Per-group configuration for Telegram GramJS adapter.
 */
export type TelegramGramJSGroupConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the adapter for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders (ids or usernames). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

/**
 * Configuration for a single Telegram GramJS user account.
 */
export type TelegramGramJSAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;

  /** If false, do not start this account. Default: true. */
  enabled?: boolean;

  // ============================================
  // Authentication & Session
  // ============================================

  /**
   * Telegram API ID (integer). Get from https://my.telegram.org/apps
   * Required for user account authentication.
   */
  apiId?: number;

  /**
   * Telegram API Hash (string). Get from https://my.telegram.org/apps
   * Required for user account authentication.
   */
  apiHash?: string;

  /**
   * Phone number for authentication (format: +1234567890).
   * Only needed during initial setup; not stored after session is created.
   */
  phoneNumber?: string;

  /**
   * GramJS StringSession (encrypted at rest).
   * Contains authentication tokens. Generated during first login.
   */
  sessionString?: string;

  /**
   * Path to file containing encrypted session string (for secret managers).
   * Alternative to sessionString for external secret management.
   */
  sessionFile?: string;

  // ============================================
  // Policies & Access Control
  // ============================================

  /**
   * Controls how Telegram direct chats (DMs) are handled:
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

  /** Allowlist for DM senders (user ids or usernames). */
  allowFrom?: Array<string | number>;

  /** Optional allowlist for Telegram group senders (user ids or usernames). */
  groupAllowFrom?: Array<string | number>;

  // ============================================
  // Features & Capabilities
  // ============================================

  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: TelegramGramJSCapabilitiesConfig;

  /** Markdown formatting overrides. */
  markdown?: MarkdownConfig;

  /** Override native command registration (bool or "auto"). */
  commands?: ProviderCommandsConfig;

  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;

  // ============================================
  // Message Handling
  // ============================================

  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;

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

  /** Draft streaming mode (off|partial|block). Default: off (not supported yet). */
  streamMode?: "off" | "partial" | "block";

  /** Disable block streaming for this account. */
  blockStreaming?: boolean;

  /** Chunking config for draft streaming. */
  draftChunk?: BlockStreamingChunkConfig;

  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;

  // ============================================
  // Media & Performance
  // ============================================

  /** Maximum media file size in MB. Default: 50. */
  mediaMaxMb?: number;

  /** Retry policy for outbound API calls. */
  retry?: OutboundRetryConfig;

  /** Request timeout in seconds. Default: 30. */
  timeoutSeconds?: number;

  // ============================================
  // Network & Proxy
  // ============================================

  /**
   * Optional SOCKS proxy URL (e.g., socks5://localhost:1080).
   * GramJS supports SOCKS4/5 and MTProxy.
   */
  proxy?: string;

  // ============================================
  // Groups & Topics
  // ============================================

  /** Per-group configuration (key is group chat id as string). */
  groups?: Record<string, TelegramGramJSGroupConfig>;

  // ============================================
  // Actions & Tools
  // ============================================

  /** Per-action tool gating (default: true for all). */
  actions?: TelegramGramJSActionConfig;

  /**
   * Controls which user reactions trigger notifications:
   * - "off" (default): ignore all reactions
   * - "own": notify when users react to our messages
   * - "all": notify agent of all reactions
   */
  reactionNotifications?: "off" | "own" | "all";

  /**
   * Controls agent's reaction capability:
   * - "off": agent cannot react
   * - "ack" (default): send acknowledgment reactions (👀 while processing)
   * - "minimal": agent can react sparingly
   * - "extensive": agent can react liberally
   */
  reactionLevel?: "off" | "ack" | "minimal" | "extensive";

  // ============================================
  // Heartbeat & Visibility
  // ============================================

  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;

  /** Controls whether link previews are shown. Default: true. */
  linkPreview?: boolean;
};

/**
 * Root configuration for Telegram GramJS user account adapter.
 * Supports multi-account setup.
 */
export type TelegramGramJSConfig = {
  /** Optional per-account configuration (multi-account). */
  accounts?: Record<string, TelegramGramJSAccountConfig>;
} & TelegramGramJSAccountConfig;
