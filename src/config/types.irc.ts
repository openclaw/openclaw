import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type IrcAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this IRC account. Default: true. */
  enabled?: boolean;
  /** IRC server hostname (example: irc.libera.chat). */
  host?: string;
  /** IRC server port (default: 6697 with TLS, otherwise 6667). */
  port?: number;
  /** Use TLS for IRC connection (default: true). */
  tls?: boolean;
  /** IRC nickname to identify this bot. */
  nick?: string;
  /** IRC USER field username (defaults to nick). */
  username?: string;
  /** IRC USER field realname (default: OpenClaw). */
  realname?: string;
  /** Optional IRC server password (sensitive). */
  password?: string;
  /** Optional file path containing IRC server password. */
  passwordFile?: string;
  /** Optional NickServ identify/register settings. */
  nickserv?: {
    /** Enable NickServ identify/register after connect (default: enabled when password is set). */
    enabled?: boolean;
    /** NickServ service nick (default: NickServ). */
    service?: string;
    /** NickServ password (sensitive). */
    password?: string;
    /** Optional file path containing NickServ password. */
    passwordFile?: string;
    /** If true, send NickServ REGISTER on connect. */
    register?: boolean;
    /** Email used with NickServ REGISTER. */
    registerEmail?: string;
  };
  /** Auto-join channel list at connect (example: ["#openclaw"]). */
  channels?: string[];
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for inbound DM senders. */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for IRC channel senders. */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how channel messages are handled:
   * - "open": channels bypass allowFrom; mention-gating applies
   * - "disabled": block all channel messages entirely
   * - "allowlist": only allow channel messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max channel messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by sender ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 350. */
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
      allowFrom?: Array<string | number>;
      skills?: string[];
      enabled?: boolean;
      systemPrompt?: string;
    }
  >;
  /** Optional mention patterns specific to IRC channel messages. */
  mentionPatterns?: string[];
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
};

export type IrcConfig = {
  /** Optional per-account IRC configuration (multi-account). */
  accounts?: Record<string, IrcAccountConfig>;
} & IrcAccountConfig;
