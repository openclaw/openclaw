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
import type { GroupToolPolicyConfig } from "./types.tools.js";

export type FeishuActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
};

/**
 * Event subscription mode for Feishu:
 * - "webhook": Use HTTP webhook to receive events (requires public URL)
 * - "websocket": Use WebSocket long connection (no public URL required)
 */
export type FeishuEventMode = "webhook" | "websocket";

export type FeishuAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Feishu account. Default: true. */
  enabled?: boolean;

  /**
   * Text to append to user input for prompt enhancement.
   * This text will be added after the user's message before sending to the agent.
   * Useful for adding context, instructions, or constraints to all user requests.
   */
  promptSuffix?: string;

  /** Feishu App ID (from Feishu Open Platform). */
  appId?: string;
  /** Feishu App Secret (from Feishu Open Platform). */
  appSecret?: string;
  /** Path to file containing App Secret (for secret managers). */
  appSecretFile?: string;
  /** Verification token for webhook events. */
  verificationToken?: string;
  /** Encrypt key for event decryption (optional). */
  encryptKey?: string;

  /**
   * Chat IDs to send a startup message to when gateway starts.
   * Supports one or multiple group chat IDs (array or legacy single string).
   */
  startupChatId?: string | string[];

  /**
   * When true, only allow messages from groups listed in startupChatId;
   * private chats (DMs) are not allowed. Ignored if startupChatId is empty.
   */
  allowOnlyStartupChats?: boolean;

  /**
   * Event subscription mode:
   * - "webhook": HTTP webhook (requires public URL)
   * - "websocket": WebSocket long connection (recommended, no public URL needed)
   * Default: "websocket"
   */
  eventMode?: FeishuEventMode;

  /** Webhook URL for receiving events (if eventMode is "webhook"). */
  webhookUrl?: string;
  /** Webhook path for receiving events. Default: "/feishu-webhook". */
  webhookPath?: string;
  /** Port for webhook server. */
  webhookPort?: number;

  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides. */
  markdown?: MarkdownConfig;
  /** Override native command registration for Feishu. */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;

  /**
   * Controls how Feishu direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom
   * - "open": allow all inbound DMs
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;

  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;

  /** Per-group configuration. */
  groups?: Record<string, FeishuGroupConfig>;

  /** Allowlist for DM senders (user IDs or open_ids). */
  allowFrom?: string[];
  /** Optional allowlist for Feishu group senders. */
  groupAllowFrom?: string[];

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

  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Chunking config for draft streaming. */
  draftChunk?: BlockStreamingChunkConfig;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Draft streaming mode (off|partial|block). Default: partial. */
  streamMode?: "off" | "partial" | "block";

  /** Max media file size in MB. Default: 20. */
  mediaMaxMb?: number;
  /**
   * When sending images, "double write" them:
   * - send as `image` message for inline preview
   * - then also send as `file` attachment for easier download / preserving bytes
   *
   * Default: false.
   */
  imageDoubleSend?: boolean;
  /** API timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
  /** Retry policy for outbound API calls. */
  retry?: OutboundRetryConfig;

  /** Per-action tool gating (default: true for all). */
  actions?: FeishuActionConfig;

  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type FeishuGroupConfig = {
  /** If true, require @mention to respond in this group. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  /** If specified, only load these skills for this group. */
  skills?: string[];
  /** If false, disable the bot for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders. */
  allowFrom?: string[];
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
  /**
   * Text to append to user input for prompt enhancement (per-group override).
   * Overrides account-level promptSuffix if set.
   */
  promptSuffix?: string;
};

export type FeishuConfig = {
  /** Optional per-account Feishu configuration (multi-account). */
  accounts?: Record<string, FeishuAccountConfig>;
} & FeishuAccountConfig;
