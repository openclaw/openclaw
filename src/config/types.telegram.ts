// Defines Telegram channel configuration types.
import type {
  ChannelPreviewStreamingConfig,
  DmPolicy,
  GroupPolicy,
  SessionThreadBindingsConfig,
} from "./types.base.js";
import type {
  ChannelExecApprovalConfig,
  ChannelExecApprovalTarget,
  ChannelReactionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { ProviderCommandsConfig } from "./types.messages.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type TelegramActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  /** Enable poll creation. Requires sendMessage to also be enabled. */
  poll?: boolean;
  deleteMessage?: boolean;
  editMessage?: boolean;
  /** Enable sticker actions (send and search). */
  sticker?: boolean;
  /** Enable forum topic creation. */
  createForumTopic?: boolean;
  /** Enable forum topic editing (rename / change icon). */
  editForumTopic?: boolean;
};

export type TelegramThreadBindingsConfig = SessionThreadBindingsConfig;

export type TelegramNetworkConfig = {
  /** Override Node's autoSelectFamily behavior (true = enable, false = disable). */
  autoSelectFamily?: boolean;
  /**
   * DNS result order for network requests ("ipv4first" | "verbatim").
   * Set to "ipv4first" to prioritize IPv4 addresses and work around IPv6 issues.
   * Default: "ipv4first" on Node 22+ to avoid common fetch failures.
   */
  dnsResultOrder?: "ipv4first" | "verbatim";
  /**
   * Dangerous opt-in for Telegram media downloads in trusted fake-IP or
   * transparent-proxy environments that resolve api.telegram.org to
   * private/internal/special-use addresses.
   */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type TelegramInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";
export type TelegramStreamingMode = "off" | "partial" | "block" | "progress";
export type TelegramExecApprovalTarget = ChannelExecApprovalTarget;

export type TelegramPreviewStreamingConfig = ChannelPreviewStreamingConfig;

export type TelegramExecApprovalConfig = ChannelExecApprovalConfig;

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

export type TelegramAccountConfig = CommonChannelMessagingConfig<
  TelegramCapabilitiesConfig,
  string | number,
  string | number,
  TelegramPreviewStreamingConfig
> &
  ChannelReactionConfig<"off" | "own" | "all", "off" | "ack" | "minimal" | "extensive", string> & {
    /** Post a room-specific introduction when joining a group. Default: true. */
    joinIntro?: boolean;
    /** Telegram-native exec approval delivery + approver authorization. */
    execApprovals?: TelegramExecApprovalConfig;
    /** Override native command registration for Telegram (bool or "auto"). */
    commands?: ProviderCommandsConfig;
    /** Custom commands to register in Telegram's command menu (merged with native). */
    customCommands?: TelegramCustomCommand[];
    botToken?: SecretInput;
    /** Path to a regular file containing the bot token; symlinks are rejected. */
    tokenFile?: string;
    groups?: Record<string, TelegramGroupConfig>;
    /** Per-DM configuration for Telegram DM topics (key is chat ID). */
    direct?: Record<string, TelegramDirectConfig>;
    /**
     * Use Telegram Bot API 10.3 rich messages for text sends and edits.
     * When false (default), falls back to HTML/plain text formatting via sendMessage.
     * Set to true to enable native tables, details, and rich media via sendRichMessage.
     * Note: Some Telegram clients (Web, Desktop, older mobile) do NOT support
     * sendRichMessage and will show "This message is not supported" errors.
     * Default: false.
     */
    richMessages?: boolean;
    /** Network transport overrides for Telegram. */
    network?: TelegramNetworkConfig;
    proxy?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    webhookPath?: string;
    /** Webhook forwarding endpoint (default 127.0.0.1:8787); false uses only the Gateway port. */
    legacyWebhook?: false | { port: number; host?: string };
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.host. */
    webhookHost?: string;
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.port. */
    webhookPort?: number;
    /** Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. */
    webhookCertPath?: string;
    /** Per-action tool gating (default: true for all). */
    actions?: TelegramActionConfig;
    /** Telegram thread/conversation binding overrides. */
    threadBindings?: TelegramThreadBindingsConfig;
    /** Controls whether link previews are shown in outbound messages. Default: true. */
    linkPreview?: boolean;
    /** Send Telegram bot error replies silently (no notification sound). Default: false. */
    silentErrorReplies?: boolean;
    /** Controls outbound error reporting: always, once per cooldown window, or silent. */
    errorPolicy?: "always" | "once" | "silent";
    /** Custom Telegram Bot API root URL (e.g. "https://my-proxy.example.com" or a local Bot API server), not a /bot<TOKEN> endpoint. */
    apiRoot?: string;
    /** Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. */
    trustedLocalFileRoots?: string[];
    /** Auto-rename DM forum topics on first message using LLM. Default: true. */
    autoTopicLabel?: AutoTopicLabelConfig;
  };

export type TelegramTopicConfig = {
  requireMention?: boolean;
  /** Emit internal message hooks for mention-skipped topic messages. */
  ingest?: boolean;
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
  /** If true, skip automatic voice-note transcription for mention detection in this topic. */
  disableAudioPreflight?: boolean;
  /** Route this topic to a specific agent (overrides group-level and binding routing). */
  agentId?: string;
  /** Controls outbound error reporting for this topic. */
  errorPolicy?: "always" | "once" | "silent";
};

export type TelegramGroupConfig = Omit<TelegramTopicConfig, "agentId"> & {
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Per-topic configuration (key is message_thread_id as string, or "*" for topic defaults). */
  topics?: Record<string, TelegramTopicConfig>;
};

/** Config for LLM-based auto-topic labeling. */
export type AutoTopicLabelConfig =
  | boolean
  | {
      enabled?: boolean;
      /** Custom prompt for LLM-based topic naming. */
      prompt?: string;
    };

export type TelegramDirectConfig = {
  /** Per-DM override for DM message policy (open|disabled|allowlist). */
  dmPolicy?: DmPolicy;
  /** Optional tool policy overrides for this DM. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this DM (when no topic). Omit = all skills; empty = no skills. */
  skills?: string[];
  /** Per-topic configuration for DM topics (key is message_thread_id as string, or "*" for topic defaults). */
  topics?: Record<string, TelegramTopicConfig>;
  /** If false, disable the bot for this DM (and its topics). */
  enabled?: boolean;
  /** If true, require messages to be from a topic when topics are enabled. */
  requireTopic?: boolean;
  /** Optional allowlist for DM senders (numeric Telegram user IDs). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this DM. */
  systemPrompt?: string;
  /** Controls outbound error reporting for this DM. */
  errorPolicy?: "always" | "once" | "silent";
  /** Auto-rename DM forum topics on first message using LLM. Default: true. */
  autoTopicLabel?: AutoTopicLabelConfig;
};

export type TelegramConfig = {
  /** Optional per-account Telegram configuration (multi-account). */
  accounts?: Record<string, TelegramAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & TelegramAccountConfig;
