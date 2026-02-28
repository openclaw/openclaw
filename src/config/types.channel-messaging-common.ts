import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";

export type CommonChannelMessagingConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this account. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound DM senders. */
  allowFrom?: Array<string | number>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional allowlist for group/channel senders. */
  groupAllowFrom?: Array<string | number>;
  /** Group/channel message handling policy. */
  groupPolicy?: GroupPolicy;
  /** Max group/channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by sender ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
};
