import type { GroupPolicy } from "./types.base.js";
import type { DiscordConfig } from "./types.discord.js";
import type { GoogleChatConfig } from "./types.googlechat.js";
import type { IMessageConfig } from "./types.imessage.js";
import type { IrcConfig } from "./types.irc.js";
import type { MSTeamsConfig } from "./types.msteams.js";
import type { SignalConfig } from "./types.signal.js";
import type { SlackConfig } from "./types.slack.js";
import type { TelegramConfig } from "./types.telegram.js";
import type { WhatsAppConfig } from "./types.whatsapp.js";

export type ChannelHeartbeatVisibilityConfig = {
  /** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
  showOk?: boolean;
  /** Show heartbeat alerts with actual content (default: true). */
  showAlerts?: boolean;
  /** Emit indicator events for UI status display (default: true). */
  useIndicator?: boolean;
};

/**
 * How to handle transient API errors (rate limit, overloaded, timeout) in channels.
 * - "reply": Send error text as a reply in the channel (default)
 * - "silent": Swallow the error, log server-side only
 * - "react-only": React with ⚠️ emoji on the triggering message instead of text reply
 */
export type ErrorPolicy = "reply" | "silent" | "react-only";

export type ChannelDefaultsConfig = {
  groupPolicy?: GroupPolicy;
  /** Default heartbeat visibility for all channels. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** How to handle transient API errors in group chats (default: "reply"). */
  errorPolicy?: ErrorPolicy;
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
  /** How to handle transient API errors (rate limit, overloaded, timeout). */
  errorPolicy?: ErrorPolicy;
  accounts?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ChannelsConfig = {
  defaults?: ChannelDefaultsConfig;
  /** Map provider -> channel id -> model override. */
  modelByChannel?: ChannelModelByChannelConfig;
  whatsapp?: WhatsAppConfig;
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  irc?: IrcConfig;
  googlechat?: GoogleChatConfig;
  slack?: SlackConfig;
  signal?: SignalConfig;
  imessage?: IMessageConfig;
  msteams?: MSTeamsConfig;
  // Extension channels use dynamic keys - use ExtensionChannelConfig in extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};
