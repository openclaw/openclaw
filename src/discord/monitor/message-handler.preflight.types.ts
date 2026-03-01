import type { ChannelType, Client, User } from "@buape/carbon";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ReplyToMode } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordChannelInfo } from "./message-utils.js";
import type { DiscordThreadBindingLookup } from "./reply-delivery.js";
import type { DiscordSenderIdentity } from "./sender-identity.js";

export type { DiscordSenderIdentity } from "./sender-identity.js";
import type { DiscordThreadChannel } from "./threading.js";

export type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
export type RuntimeEnv = import("../../runtime.js").RuntimeEnv;

export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;

export type DiscordMessagePreflightContext = {
  cfg: LoadedConfig;
  discordConfig: NonNullable<
    import("../../config/config.js").OpenClawConfig["channels"]
  >["discord"];
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  ackReactionScope: "all" | "direct" | "group-all" | "group-mentions";
  groupPolicy: "open" | "disabled" | "allowlist";

  data: DiscordMessageEvent;
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId: string;
  author: User;
  sender: DiscordSenderIdentity;

  channelInfo: DiscordChannelInfo | null;
  channelName?: string;

  isGuildMessage: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;

  commandAuthorized: boolean;
  baseText: string;
  messageText: string;
  wasMentioned: boolean;

  route: ReturnType<typeof resolveAgentRoute>;
  threadBinding?: SessionBindingRecord;
  boundSessionKey?: string;
  boundAgentId?: string;

  guildInfo: DiscordGuildEntryResolved | null;
  guildSlug: string;

  threadChannel: DiscordThreadChannel | null;
  threadParentId?: string;
  threadParentName?: string;
  threadParentType?: ChannelType;
  threadName?: string | null;

  configChannelName?: string;
  configChannelSlug: string;
  displayChannelName?: string;
  displayChannelSlug: string;

  baseSessionKey: string;
  channelConfig: DiscordChannelConfigResolved | null;
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;

  shouldRequireMention: boolean;
  hasAnyMention: boolean;
  allowTextCommands: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  canDetectMention: boolean;

  historyEntry?: HistoryEntry;
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
};

export type DiscordMessagePreflightParams = {
  cfg: LoadedConfig;
  discordConfig: DiscordMessagePreflightContext["discordConfig"];
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  allowFrom?: string[];
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  ackReactionScope: DiscordMessagePreflightContext["ackReactionScope"];
  groupPolicy: DiscordMessagePreflightContext["groupPolicy"];
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
  data: DiscordMessageEvent;
  client: Client;
};
