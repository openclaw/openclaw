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
 * - `"stop-start"` (default): full stop → start cycle that also resets the
 *   restart-attempt counter. Reliable across all providers.
 * - `"graceful"`: stop → start without resetting the restart-attempt counter.
 *   Signals to the channel runtime that this is a soft recovery rather than
 *   a hard restart, which allows providers that track consecutive restarts
 *   (e.g. to apply escalating backoff) to distinguish transient stale-socket
 *   events from genuine failure loops. Does **not** automatically preserve
 *   SDK-level session state — that depends on the provider implementation.
 */
export type ChannelHealthRestartMode = "stop-start" | "graceful";

export type ChannelHealthMonitorConfig = {
  /**
   * Enable channel-health-monitor restarts for this channel or account.
   * Inherits the global gateway setting when omitted.
   */
  enabled?: boolean;
  /**
   * How to restart a stale channel.
   * `"graceful"` performs a stop → start without resetting the restart-attempt
   * counter, signalling a soft recovery to the channel runtime.
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
