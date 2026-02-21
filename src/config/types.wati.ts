import type { DmPolicy } from "./types.base.js";
import type { BlockStreamingCoalesceConfig } from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";

export type WatiAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this WATI account. Default: true. */
  enabled?: boolean;
  /** WATI API bearer token. */
  apiToken?: string;
  /** WATI API base URL. Default: https://live-mt-server.wati.io */
  apiBaseUrl?: string;
  /** WATI tenant ID. */
  tenantId?: string;
  /** Public webhook URL for WATI to send callbacks to. */
  webhookUrl?: string;
  /** Secret for webhook signature verification. */
  webhookSecret?: string;
  /** Webhook path. Default: /webhook/wati */
  webhookPath?: string;
  /** Local webhook listener bind host. */
  webhookHost?: string;
  /** Webhook port. Default: 3001 */
  webhookPort?: number;
  /**
   * Controls how WATI direct messages are handled:
   * - "open" (default): allow all inbound DMs (WATI is a business API)
   * - "allowlist": only allow senders in allowFrom
   * - "pairing": unknown senders get a pairing code
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /** DM allowlist (phone numbers). */
  allowFrom?: string[];
  /** Default delivery target for CLI `--deliver` when no explicit `--reply-to` is provided. */
  defaultTo?: string;
  /** Outbound text chunk size (chars). */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /**
   * Per-channel outbound response prefix override.
   *
   * When set, this takes precedence over the global `messages.responsePrefix`.
   * Use `""` to explicitly disable a global prefix for this channel.
   * Use `"auto"` to derive `[{identity.name}]` from the routed agent.
   */
  responsePrefix?: string;
};

export type WatiConfig = WatiAccountConfig & {
  /** Optional per-account WATI configuration (multi-account). */
  accounts?: Record<string, WatiAccountConfig>;
};
