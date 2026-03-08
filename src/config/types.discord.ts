import type { DiscordPluralKitConfig } from "../discord/pluralkit.js";
import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
  ReplyToMode,
} from "./types.base.js";

/**
 * Configuration for DM retry behavior (agent-to-agent communication).
 * When enabled, outbound DMs are tracked and auto-retried if no response is received.
 */
export type DmRetryConfig = {
  /** Enable DM retry tracking for agent-to-agent messages. Default: false. */
  enabled?: boolean;
  /** Timeout in ms before considering a DM unresponded. Default: 300000 (5 min). */
  timeoutMs?: number;
  /** Maximum retry attempts before marking as failed. Default: 3. */
  maxAttempts?: number;
  /** Delay in ms between retry attempts. Default: 60000 (1 min). */
  backoffMs?: number;
  /** Notify sender when all retries fail. Default: true. */
  notifyOnFailure?: boolean;
};
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";

export type DiscordDmConfig = {
  /** If false, ignore all incoming Discord DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (ids or names). */
  allowFrom?: string[];
  /** If true, allow group DMs (default: false). */
  groupEnabled?: boolean;
  /** Optional allowlist for group DM channels (ids or slugs). */
  groupChannels?: string[];
  /** DM retry configuration for agent-to-agent communication. */
  retry?: DmRetryConfig;
};

export type DiscordGuildChannelConfig = {
  allow?: boolean;
  requireMention?: boolean;
  /**
   * If true, drop messages that mention another user/role but not this one (not @everyone/@here).
   * Default: false.
   */
  ignoreOtherMentions?: boolean;
  /** Optional tool policy overrides for this channel. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this channel. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this channel. */
  enabled?: boolean;
  /** Optional allowlist for channel senders (ids or names). */
  users?: string[];
  /** Optional allowlist for channel senders by role ID. */
  roles?: string[];
  /** Optional system prompt snippet for this channel. */
  systemPrompt?: string;
  /** If false, omit thread starter context for this channel (default: true). */
  includeThreadStarter?: boolean;
};

export type DiscordReactionNotificationMode = "off" | "own" | "all" | "allowlist";

export type DiscordGuildEntry = {
  slug?: string;
  requireMention?: boolean;
  /**
   * If true, drop messages that mention another user/role but not this one (not @everyone/@here).
   * Default: false.
   */
  ignoreOtherMentions?: boolean;
  /** Optional tool policy overrides for this guild (used when channel override is missing). */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: DiscordReactionNotificationMode;
  /** Optional allowlist for guild senders (ids or names). */
  users?: string[];
  /** Optional allowlist for guild senders by role ID. */
  roles?: string[];
  channels?: Record<string, DiscordGuildChannelConfig>;
};

export type DiscordActionConfig = {
  reactions?: boolean;
  stickers?: boolean;
  polls?: boolean;
  permissions?: boolean;
  messages?: boolean;
  threads?: boolean;
  pins?: boolean;
  search?: boolean;
  memberInfo?: boolean;
  roleInfo?: boolean;
  roles?: boolean;
  channelInfo?: boolean;
  voiceStatus?: boolean;
  events?: boolean;
  moderation?: boolean;
  emojiUploads?: boolean;
  stickerUploads?: boolean;
  channels?: boolean;
  /** Enable bot presence/activity changes (default: false). */
  presence?: boolean;
};

export type DiscordIntentsConfig = {
  /** Enable Guild Presences privileged intent (requires Portal opt-in). Default: false. */
  presence?: boolean;
  /** Enable Guild Members privileged intent (requires Portal opt-in). Default: false. */
  guildMembers?: boolean;
};

export type DiscordVoiceAutoJoinConfig = {
  /** Guild ID that owns the voice channel. */
  guildId: string;
  /** Voice channel ID to join. */
  channelId: string;
};

export type DiscordVoiceConfig = {
  /** Enable Discord voice channel conversations (default: true). */
  enabled?: boolean;
  /** Voice channels to auto-join on startup. */
  autoJoin?: DiscordVoiceAutoJoinConfig[];
  /** Enable/disable DAVE end-to-end encryption (default: true; Discord may require this). */
  daveEncryption?: boolean;
  /** Consecutive decrypt failures before DAVE session reinitialization (default: 24). */
  decryptionFailureTolerance?: number;
  /** Optional TTS overrides for Discord voice output. */
  tts?: TtsConfig;
};

export type DiscordExecApprovalConfig = {
  /** Enable exec approval forwarding to Discord DMs. Default: false. */
  enabled?: boolean;
  /** Discord user IDs to receive approval prompts. Required if enabled. */
  approvers?: string[];
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Delete approval DMs after approval, denial, or timeout. Default: false. */
  cleanupAfterResolve?: boolean;
  /** Where to send approval prompts. "dm" sends to approver DMs (default), "channel" sends to the
   *  originating Discord channel, "both" sends to both. When target is "channel" or "both", buttons
   *  are only usable by configured approvers; other users receive an ephemeral denial. */
  target?: "dm" | "channel" | "both";
};

export type DiscordTaskApprovalConfig = {
  /** Enable task approval forwarding to Discord DMs. Default: false. */
  enabled?: boolean;
  /** Discord user IDs to receive task approval prompts. Required if enabled. */
  approvers?: Array<string | number>;
  /** Optional Task Hub base URL used for "Open Task Hub" button. */
  taskHubUrl?: string;
};

export type DiscordAgentComponentsConfig = {
  /** Enable agent-controlled interactive components (buttons, select menus). Default: true. */
  enabled?: boolean;
};

export type DiscordUiComponentsConfig = {
  /** Accent color used by Discord component containers (hex). */
  accentColor?: string;
};

export type DiscordUiConfig = {
  components?: DiscordUiComponentsConfig;
};

export type DiscordThreadBindingsConfig = {
  /**
   * Enable Discord thread binding features (/focus, thread-bound delivery, and
   * thread-bound subagent session flows). Overrides session.threadBindings.enabled
   * when set.
   */
  enabled?: boolean;
  /**
   * Inactivity window for thread-bound sessions in hours.
   * Session auto-unfocuses after this amount of idle time. Set to 0 to disable. Default: 24.
   */
  idleHours?: number;
  /**
   * Optional hard max age for thread-bound sessions in hours.
   * Session auto-unfocuses once this age is reached even if active. Set to 0 to disable. Default: 0.
   */
  maxAgeHours?: number;
  /**
   * Allow `sessions_spawn({ thread: true })` to auto-create + bind Discord
   * threads for subagent sessions. Default: false (opt-in).
   */
  spawnSubagentSessions?: boolean;
  /**
   * Allow `/acp spawn` to auto-create + bind Discord threads for ACP
   * sessions. Default: false (opt-in).
   */
  spawnAcpSessions?: boolean;
};

/**
 * Configuration for A2A (agent-to-agent) mention retry behavior.
 * When enabled, outbound agent mentions in threads are tracked and auto-retried if no response is received.
 */
export type A2aRetryConfig = {
  /** Enable A2A mention retry tracking. Default: false. */
  enabled?: boolean;
  /** Timeout in ms before considering a mention unresponded. Default: 300000 (5 min). */
  responseTimeoutMs?: number;
  /** Maximum retry attempts before marking as failed. Default: 3. */
  maxAttempts?: number;
  /** Polling interval in ms for checking timed-out mentions. Default: 60000 (1 min). */
  checkIntervalMs?: number;
  /** Max age in ms before cleaning up old entries. Default: 86400000 (24h). */
  cleanupMaxAgeMs?: number;
  /** Discord user ID to mention when all retries fail (escalation). */
  escalationMentionId?: string;
  /** Notify in thread when all retries fail. Default: true. */
  notifyOnFailure?: boolean;
  /**
   * Auto-unfocus TTL for thread-bound sessions in hours.
   * Set to 0 to disable TTL. Default: 24.
   */
  ttlHours?: number;
  /**
   * Allow `sessions_spawn({ thread: true })` to auto-create + bind Discord
   * threads for subagent sessions. Default: false (opt-in).
   */
  spawnSubagentSessions?: boolean;
  /**
   * Allow `/acp spawn` to auto-create + bind Discord threads for ACP
   * sessions. Default: false (opt-in).
   */
  spawnAcpSessions?: boolean;
};

/**
 * Configuration for Discord thread-based agent-to-agent communication.
 * When enabled, sibling bot mentions in threads are processed through the agent pipeline
 * instead of being dropped by the bot filter.
 */
export type ThreadCommunicationConfig = {
  /** Enable thread-based A2A communication. Default: false. */
  enabled?: boolean;
  /** Allow sibling bot mentions in threads to trigger agent processing. Default: true (when enabled). */
  allowSiblingMentionsInThreads?: boolean;
};

export type DiscordAutoPresenceConfig = {
  /** Enable automatic runtime/quota-based Discord presence updates. Default: false. */
  enabled?: boolean;
  /** Poll interval for evaluating runtime availability state (ms). Default: 30000. */
  intervalMs?: number;
  /** Minimum spacing between actual gateway presence updates (ms). Default: 15000. */
  minUpdateIntervalMs?: number;
  /** Optional custom status text while runtime is healthy; supports plain text. */
  healthyText?: string;
  /** Optional custom status text while runtime/quota state is degraded or unknown. */
  degradedText?: string;
  /** Optional custom status text while runtime detects quota/token exhaustion. */
  exhaustedText?: string;
};

export type DiscordAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for Discord (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Discord account. Default: true. */
  enabled?: boolean;
  token?: SecretInput;
  /** HTTP(S) proxy URL for Discord gateway WebSocket connections. */
  proxy?: string;
  /** Allow bot-authored messages to trigger replies (default: false). Set "mentions" to gate on mentions. */
  allowBots?: boolean | "mentions";
  /**
   * Break-glass override: allow mutable identity matching (names/tags/slugs) in allowlists.
   * Default behavior is ID-only matching.
   */
  dangerouslyAllowNameMatching?: boolean;
  /**
   * Controls how guild channel messages are handled:
   * - "open": guild channels bypass allowlists; mention-gating applies
   * - "disabled": block all guild channel messages
   * - "allowlist": only allow channels present in discord.guilds.*.channels
   */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 2000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Soft max line count per Discord message.
   * Discord clients can clip/collapse very tall messages; splitting by lines
   * keeps replies readable in-channel. Default: 17.
   */
  maxLinesPerMessage?: number;
  mediaMaxMb?: number;
  historyLimit?: number;
  /** If true, record bot messages to guild history context (for multi-agent visibility). Default: false. */
  /** If true, record bot messages to guild history context (for multi-agent visibility). Default: false. */
  historyIncludeBots?: boolean;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Retry policy for outbound Discord API calls. */
  retry?: OutboundRetryConfig;
  /** Per-action tool gating (default: true for all). */
  actions?: DiscordActionConfig;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  /**
   * Alias for dm.policy (prefer this so it inherits cleanly via base->account shallow merge).
   * Legacy key: channels.discord.dm.policy.
   */
  dmPolicy?: DmPolicy;
  /**
   * Alias for dm.allowFrom (prefer this so it inherits cleanly via base->account shallow merge).
   * Legacy key: channels.discord.dm.allowFrom.
   */
  allowFrom?: string[];
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  dm?: DiscordDmConfig;
  /** Thread-based agent-to-agent communication configuration. */
  threadCommunication?: ThreadCommunicationConfig;
  /** A2A mention retry configuration for thread communication. */
  a2aRetry?: A2aRetryConfig;
  /** New per-guild config keyed by guild id or slug. */
  guilds?: Record<string, DiscordGuildEntry>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Exec approval forwarding configuration. */
  execApprovals?: DiscordExecApprovalConfig;
  /** Task approval forwarding configuration. */
  taskApprovals?: DiscordTaskApprovalConfig;
  /** Agent-controlled interactive components (buttons, select menus). */
  agentComponents?: DiscordAgentComponentsConfig;
  /** Discord UI customization (components, modals, etc.). */
  ui?: DiscordUiConfig;
  /** Thread binding lifecycle settings (focus/subagent thread sessions). */
  threadBindings?: DiscordThreadBindingsConfig;
  /** Privileged Gateway Intents (must also be enabled in Discord Developer Portal). */
  intents?: DiscordIntentsConfig;
  /** Voice channel conversation settings. */
  voice?: DiscordVoiceConfig;
  /** PluralKit identity resolution for proxied messages. */
  pluralkit?: DiscordPluralKitConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /**
   * Per-channel ack reaction override.
   * Discord supports both unicode emoji and custom emoji names.
   */
  ackReaction?: string;
  /** When to send ack reactions for this Discord account. Overrides messages.ackReactionScope. */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all" | "off" | "none";
  /** Bot activity status text (e.g. "Watching X"). */
  activity?: string;
  /** Bot status (online|dnd|idle|invisible). Defaults to online when presence is configured. */
  status?: "online" | "dnd" | "idle" | "invisible";
  /** Automatic runtime/quota presence signaling (status text + status mapping). */
  autoPresence?: DiscordAutoPresenceConfig;
  /** Activity type (0=Game, 1=Streaming, 2=Listening, 3=Watching, 4=Custom, 5=Competing). Defaults to 4 (Custom) when activity is set. */
  activityType?: 0 | 1 | 2 | 3 | 4 | 5;
  /** Streaming URL (Twitch/YouTube). Required when activityType=1. */
  activityUrl?: string;
  /**
   * In-process worker settings for queued inbound Discord runs.
   * This is separate from Carbon's eventQueue listener budget.
   */
  inboundWorker?: {
    /**
     * Max time (ms) a queued inbound run may execute before OpenClaw aborts it.
     * Defaults to 1800000 (30 minutes). Set 0 to disable the worker-owned timeout.
     */
    runTimeoutMs?: number;
  };
  /**
   * Carbon EventQueue configuration. Controls how Discord gateway events are processed.
   * `listenerTimeout` only covers gateway listener work such as normalization and enqueue.
   * It does not control the lifetime of queued inbound agent turns.
   */
  eventQueue?: {
    /** Max time (ms) a single listener can run before being killed. Default: 120000. */
    listenerTimeout?: number;
    /** Max events queued before backpressure is applied. Default: 10000. */
    maxQueueSize?: number;
    /** Max concurrent event processing operations. Default: 50. */
    maxConcurrency?: number;
  };
};

export type DiscordConfig = {
  /** Optional per-account Discord configuration (multi-account). */
  accounts?: Record<string, DiscordAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & DiscordAccountConfig;
