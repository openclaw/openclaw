import type {
  BlockStreamingCoalesceConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type {
  ChannelHealthMonitorConfig,
  ChannelHeartbeatVisibilityConfig,
} from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";

export type MSTeamsWebhookConfig = {
  /** Port for the webhook server. Default: 3978. */
  port?: number;
  /** Path for the messages endpoint. Default: /api/messages. */
  path?: string;
};

/** Reply style for MS Teams messages. */
export type MSTeamsReplyStyle = "thread" | "top-level";

/**
 * Permission model for Teams voice.
 *
 * - "rsc-with-admin-media": RSC for join + tenant-wide Calls.AccessMedia.All (likely required).
 * - "tenant-wide": full tenant-wide application permissions.
 * - "rsc-only": pure RSC (pending spike validation — may not work for app-hosted media).
 */
export type MSTeamsVoicePermissionMode = "rsc-with-admin-media" | "tenant-wide" | "rsc-only";

/**
 * Voice/call support configuration for MS Teams.
 *
 * Teams live voice requires a separate Windows-based .NET media worker because
 * Microsoft's Real-Time Media SDK is C#/.NET only. Without a configured worker,
 * OpenClaw falls back to text and post-meeting transcript capabilities.
 */
export type MSTeamsVoiceConfig = {
  /** Enable voice/call support. Default: false. */
  enabled?: boolean;
  /**
   * Permission mode. Default: "rsc-with-admin-media".
   * @see MSTeamsVoicePermissionMode
   */
  permissionMode?: MSTeamsVoicePermissionMode;
  /** Meetings to auto-join on startup (tenant-wide mode only). */
  autoJoin?: Array<{ joinUrl: string }>;
  /** gRPC address of the .NET media worker. Default: "localhost:9442". */
  workerAddress?: string;
  /** TTS config overrides for voice output. */
  tts?: TtsConfig;
  /** Streaming STT provider. Default: "openai-realtime". */
  sttProvider?: "openai-realtime" | "deepgram" | "whisper-file";
  /** Silence detection duration (ms), forwarded to .NET worker. Default: 1000. */
  silenceDurationMs?: number;
  /** Min audio segment duration (seconds). Default: 0.35. */
  minSegmentSeconds?: number;
  /**
   * Post-meeting transcript fallback mode (NOT real-time).
   *
   * - false: disabled (default).
   * - "rsc": app-scoped, private-chat meetings only.
   * - "tenant-wide": all meetings + ad hoc calls (requires application access policy).
   */
  transcriptFallback?: false | "rsc" | "tenant-wide";
};

/** Channel-level config for MS Teams. */
export type MSTeamsChannelConfig = {
  /** Require @mention to respond. Default: true. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this channel. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Reply style: "thread" replies to the message, "top-level" posts a new message. */
  replyStyle?: MSTeamsReplyStyle;
};

/** Team-level config for MS Teams. */
export type MSTeamsTeamConfig = {
  /** Default requireMention for channels in this team. */
  requireMention?: boolean;
  /** Default tool policy for channels in this team. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Default reply style for channels in this team. */
  replyStyle?: MSTeamsReplyStyle;
  /** Per-channel overrides. Key is conversation ID (e.g., "19:...@thread.tacv2"). */
  channels?: Record<string, MSTeamsChannelConfig>;
};

export type MSTeamsConfig = {
  /** If false, do not start the MS Teams provider. Default: true. */
  enabled?: boolean;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /**
   * Break-glass override: allow mutable identity matching (display names/UPNs) in allowlists.
   * Default behavior is ID-only matching.
   */
  dangerouslyAllowNameMatching?: boolean;
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Azure Bot App ID (from Azure Bot registration). */
  appId?: string;
  /** Azure Bot App Password / Client Secret. */
  appPassword?: SecretInput;
  /** Azure AD Tenant ID (for single-tenant bots). */
  tenantId?: string;
  /** Webhook server configuration. */
  webhook?: MSTeamsWebhookConfig;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (AAD object IDs or UPNs). */
  allowFrom?: Array<string>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional allowlist for group/channel senders (AAD object IDs or UPNs). */
  groupAllowFrom?: Array<string>;
  /**
   * Controls how group/channel messages are handled:
   * - "open": groups bypass allowFrom; mention-gating applies
   * - "disabled": block all group messages
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Supplemental context visibility policy (all|allowlist|allowlist_quote). */
  contextVisibility?: ContextVisibilityMode;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Send native Teams typing indicator before replies. Default: true for groups/channels; DMs use informative stream status. */
  typingIndicator?: boolean;
  /** Enable progressive block-by-block message delivery instead of a single reply. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Allowed host suffixes for inbound attachment downloads.
   * Use ["*"] to allow any host (not recommended).
   */
  mediaAllowHosts?: Array<string>;
  /**
   * Allowed host suffixes for attaching Authorization headers to inbound media retries.
   * Use specific hosts only; avoid multi-tenant suffixes.
   */
  mediaAuthAllowHosts?: Array<string>;
  /** Default: require @mention to respond in channels/groups. */
  requireMention?: boolean;
  /** Max group/channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Default reply style: "thread" replies to the message, "top-level" posts a new message. */
  replyStyle?: MSTeamsReplyStyle;
  /** Per-team config. Key is team ID (from the /team/ URL path segment). */
  teams?: Record<string, MSTeamsTeamConfig>;
  /** Max media size in MB (default: 100MB for OneDrive upload support). */
  mediaMaxMb?: number;
  /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2"). */
  sharePointSiteId?: string;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Channel health monitor overrides for this channel. */
  healthMonitor?: ChannelHealthMonitorConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Show a welcome Adaptive Card when the bot is added to a 1:1 chat. Default: true. */
  welcomeCard?: boolean;
  /** Custom prompt starter labels shown on the welcome card. */
  promptStarters?: string[];
  /** Show a welcome message when the bot is added to a group chat. Default: false. */
  groupWelcomeCard?: boolean;
  /** Enable the Teams feedback loop (thumbs up/down) on AI-generated messages. Default: true. */
  feedbackEnabled?: boolean;
  /** Enable background reflection when a user gives negative feedback. Default: true. */
  feedbackReflection?: boolean;
  /** Minimum interval (ms) between reflections per session. Default: 300000 (5 min). */
  feedbackReflectionCooldownMs?: number;
  /**
   * Voice/call support configuration.
   * Requires a Windows-based .NET Teams Voice Worker for live audio.
   * Without a worker, OpenClaw falls back to text + transcript mode.
   */
  voice?: MSTeamsVoiceConfig;
};

declare module "./types.channels.js" {
  interface ChannelsConfig {
    msteams?: MSTeamsConfig;
  }
}
