import type { GroupPolicy } from "./types.base.js";

export type ChannelHeartbeatVisibilityConfig = {
  /** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
  showOk?: boolean;
  /** Show heartbeat alerts with actual content (default: true). */
  showAlerts?: boolean;
  /** Emit indicator events for UI status display (default: true). */
  useIndicator?: boolean;
};

/**
 * Controls how the channel health-monitor reacts to a stale-socket condition.
 *
 * - `"stop-start"` (default): stops the channel then starts it again. Reliable
 *   but invalidates any in-memory state held by the provider client, including
 *   Anthropic's prompt-cache warm-up context.
 * - `"reconnect"`: performs a lightweight re-connect by stopping and immediately
 *   starting the channel without resetting the restart-attempt counter or
 *   emitting a full channel teardown. Preserves in-memory provider state where
 *   the underlying SDK supports session resumption (e.g. Discord gateway
 *   RESUME). Falls back to `"stop-start"` if the reconnect fails.
 */
export type ChannelHealthRestartMode = "stop-start" | "reconnect";

export type ChannelHealthMonitorConfig = {
  /**
   * Enable channel-health-monitor restarts for this channel or account.
   * Inherits the global gateway setting when omitted.
   */
  enabled?: boolean;
  /**
   * How to restart a stale channel. `"reconnect"` attempts a lightweight
   * re-connect that may preserve SDK-level session state (e.g. Discord
   * RESUME), which avoids invalidating Anthropic prompt-cache context.
   * Defaults to `"stop-start"` for backwards-compatibility.
   */
  restartMode?: ChannelHealthRestartMode;
};

export type ChannelDefaultsConfig = {
  groupPolicy?: GroupPolicy;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

/**
 * Base type for extension channel config sections.
 * Extensions can use this as a starting point for their channel config.
 */
export type ExtensionChannelConfig = {
  enabled?: boolean;
  allowFrom?: string | string[];
  /** Default delivery target for CLI --deliver when no explicit --reply-to is provided. */
  defaultTo?: string;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  dmPolicy?: string;
  groupPolicy?: GroupPolicy;
  healthMonitor?: ChannelHealthMonitorConfig;
  accounts?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ChannelsConfig {
  defaults?: ChannelDefaultsConfig;
  /** Map provider -> channel id -> model override. */
  modelByChannel?: ChannelModelByChannelConfig;
  /** Channel sections are plugin-owned; concrete channel files augment this interface. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
