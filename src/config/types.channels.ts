import type { GroupPolicy } from "./types.base.js";
import type { SlackConfig } from "./types.slack.js";
import type { TelegramConfig } from "./types.telegram.js";

export type ChannelHeartbeatVisibilityConfig = {
  /** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
  showOk?: boolean;
  /** Show heartbeat alerts with actual content (default: true). */
  showAlerts?: boolean;
  /** Emit indicator events for UI status display (default: true). */
  useIndicator?: boolean;
};

export type ChannelDefaultsConfig = {
  groupPolicy?: GroupPolicy;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

/**
 * Base type for extension channel config sections.
 * Extensions can use this as a starting point for their channel config.
 */
export type ExtensionChannelConfig = {
  enabled?: boolean;
  allowFrom?: string | string[];
  dmPolicy?: string;
  groupPolicy?: GroupPolicy;
  accounts?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ChannelsConfig = {
  defaults?: ChannelDefaultsConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  // Extension channels use dynamic keys - use ExtensionChannelConfig in extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};
