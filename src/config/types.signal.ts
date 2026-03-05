import type { CommonChannelMessagingConfig } from "./types.channel-messaging-common.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type SignalAccountConfig = CommonChannelMessagingConfig & {
  /** Optional explicit E.164 account for signal-cli. */
  account?: string;
  /** Optional account UUID for signal-cli (used for loop protection). */
  accountUuid?: string;
  /** Optional full base URL for signal-cli HTTP daemon. */
  httpUrl?: string;
  /** HTTP host for signal-cli daemon (default 127.0.0.1). */
  httpHost?: string;
  /** HTTP port for signal-cli daemon (default 8080). */
  httpPort?: number;
  /** signal-cli binary path (default: signal-cli). */
  cliPath?: string;
  /** Auto-start signal-cli daemon (default: true if httpUrl not set). */
  autoStart?: boolean;
  /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
  startupTimeoutMs?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Action toggles for message tool capabilities. */
  actions?: {
    /** Enable/disable sending reactions via message tool (default: true). */
    reactions?: boolean;
    /** Enable/disable unsending messages via message tool (default: true). */
    unsend?: boolean;
    /** Enable/disable creating polls via message tool (default: true). */
    poll?: boolean;
    /** Enable/disable voting on polls via message tool (default: true). */
    pollVote?: boolean;
    /** Enable/disable closing polls via message tool (default: true). */
    pollTerminate?: boolean;
  };
  /**
   * Controls agent reaction behavior:
   * - "off": No reactions
   * - "ack": Only automatic ack reactions (👀 when processing)
   * - "minimal": Agent can react sparingly (default)
   * - "extensive": Agent can react liberally
   */
  reactionLevel?: SignalReactionLevel;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Extract link preview metadata into UntrustedContext (default: true). */
  injectLinkPreviews?: boolean;
  /** Apply Signal text styles (bold/italic/monospace/strikethrough/spoiler) to message text (default: true). */
  preserveTextStyles?: boolean;
};

export type SignalConfig = {
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SignalAccountConfig;
