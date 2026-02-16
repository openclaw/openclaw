import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { ReactionDelivery } from "./types.reactions.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type IMessageAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this iMessage account. Default: true. */
  enabled?: boolean;
  /** imsg CLI binary path (default: imsg). */
  cliPath?: string;
  /** Optional Messages db path override. */
  dbPath?: string;
  /** Remote SSH host token for SCP attachment fetches (`host` or `user@host`). */
  remoteHost?: string;
  /** Optional default send service (imessage|sms|auto). */
  service?: "imessage" | "sms" | "auto";
  /** Optional default region (used when sending SMS). */
  region?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound handles or chat_id targets. */
  allowFrom?: Array<string | number>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional allowlist for group senders or chat_id targets. */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom; mention-gating applies
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
  /** Include attachments + reactions in watch payloads. */
  includeAttachments?: boolean;
  /** Allowed local iMessage attachment roots (supports single-segment `*` wildcards). */
  attachmentRoots?: string[];
  /** Allowed remote iMessage attachment roots for SCP fetches (supports `*`). */
  remoteAttachmentRoots?: string[];
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Timeout for probe/RPC operations in milliseconds (default: 10000). */
  probeTimeoutMs?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      tools?: GroupToolPolicyConfig;
      toolsBySender?: GroupToolPolicyBySenderConfig;
    }
  >;
  /** Reaction delivery mode: "deferred" queues for next message; "immediate" triggers own agent turn. Default: deferred. */
  reactionDelivery?: ReactionDelivery;
  /** Debounce window (ms) for bundling multiple reactions to the same message (0–60000). Default: 2000. */
  reactionBundleWindowMs?: number;
  /** When true, include the reacted-to message content in the agent context. Default: false. */
  reactionIncludeMessage?: boolean;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
};

export type IMessageConfig = {
  /** Optional per-account iMessage configuration (multi-account). */
  accounts?: Record<string, IMessageAccountConfig>;
} & IMessageAccountConfig;
