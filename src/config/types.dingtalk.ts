import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

/** Channel-level config for DingTalk. */
export type DingTalkChannelConfig = {
  /** Require @mention to respond. Default: true. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this channel. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

/** Group-level config for DingTalk. */
export type DingTalkGroupConfig = {
  /** Default requireMention for channels in this group. */
  requireMention?: boolean;
  /** Default tool policy for channels in this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Per-channel overrides. Key is conversation ID. */
  channels?: Record<string, DingTalkChannelConfig>;
};

export type DingTalkConfig = {
  /** If false, do not start the DingTalk provider. Default: true. */
  enabled?: boolean;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** DingTalk App Key (from DingTalk Open Platform). */
  appKey?: string;
  /** DingTalk App Secret. */
  appSecret?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (user IDs). */
  allowFrom?: Array<string>;
  /** Optional allowlist for group/channel senders (user IDs). */
  groupAllowFrom?: Array<string>;
  /**
   * Controls how group/channel messages are handled:
   * - "open": groups bypass allowFrom; mention-gating applies
   * - "disabled": block all group messages
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Allowed host suffixes for inbound attachment downloads.
   * Use ["*"] to allow any host (not recommended).
   */
  mediaAllowHosts?: Array<string>;
  /** Default: require @mention to respond in channels/groups. */
  requireMention?: boolean;
  /** Max group/channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Per-group config. Key is group ID. */
  groups?: Record<string, DingTalkGroupConfig>;
  /** Max media size in MB (default: 20MB). */
  mediaMaxMb?: number;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};
