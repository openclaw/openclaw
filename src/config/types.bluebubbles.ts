import type { SecretInput } from "./types.secrets.js";
import type {
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type BlueBubblesGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  enabled?: boolean;
  allowFrom?: Array<string | number>;
};

export type BlueBubblesAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this BlueBubbles account. Default: true. */
  enabled?: boolean;
  /** BlueBubbles server URL. */
  serverUrl?: string;
  /** BlueBubbles server password. */
  password?: string;
  /** Webhook path for incoming messages (default: /bb). */
  webhookPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound handles or group IDs. */
  allowFrom?: Array<string | number>;
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional allowlist for group senders or group IDs. */
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
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /** Allowed local BlueBubbles media roots. */
  mediaLocalRoots?: string[];
  /** Per-group config overrides. */
  groups?: Record<string, BlueBubblesGroupConfig>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Outbound response prefix override for this channel. */
  responsePrefix?: string;
};

export type BlueBubblesConfig = {
  /** Optional per-account BlueBubbles configuration (multi-account). */
  accounts?: Record<string, BlueBubblesAccountConfig>;
} & BlueBubblesAccountConfig;
