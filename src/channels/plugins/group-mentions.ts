import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
} from "../../config/group-policy.js";
import type { DiscordConfig } from "../../config/types.js";
import type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../../config/types.tools.js";
import { normalizeAtHashSlug, normalizeHyphenSlug } from "../../shared/string-normalization.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import type { ChannelGroupContext } from "./types.js";

type GroupMentionParams = ChannelGroupContext;

function normalizeDiscordSlug(value?: string | null) {
  return normalizeAtHashSlug(value);
}

function parseTelegramGroupId(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { chatId: undefined, topicId: undefined };
  }
  const parts = raw.split(":").filter(Boolean);
  if (
    parts.length >= 3 &&
    parts[1] === "topic" &&
    /^-?\d+$/.test(parts[0]) &&
    /^\d+$/.test(parts[2])
  ) {
    return { chatId: parts[0], topicId: parts[2] };
  }
  if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return { chatId: parts[0], topicId: parts[1] };
  }
  return { chatId: raw, topicId: undefined };
}

function resolveTelegramRequireMention(params: {
  cfg: OpenClawConfig;
  chatId?: string;
  topicId?: string;
}): boolean | undefined {
  const { cfg, chatId, topicId } = params;
  if (!chatId) {
    return undefined;
  }
  const groupConfig = cfg.channels?.telegram?.groups?.[chatId];
  const groupDefault = cfg.channels?.telegram?.groups?.["*"];
  const topicConfig = topicId && groupConfig?.topics ? groupConfig.topics[topicId] : undefined;
  const defaultTopicConfig =
    topicId && groupDefault?.topics ? groupDefault.topics[topicId] : undefined;
  if (typeof topicConfig?.requireMention === "boolean") {
    return topicConfig.requireMention;
  }
  if (typeof defaultTopicConfig?.requireMention === "boolean") {
    return defaultTopicConfig.requireMention;
  }
  if (typeof groupConfig?.requireMention === "boolean") {
    return groupConfig.requireMention;
  }
  if (typeof groupDefault?.requireMention === "boolean") {
    return groupDefault.requireMention;
  }
  return undefined;
}

function resolveDiscordGuildEntry(guilds: DiscordConfig["guilds"], groupSpace?: string | null) {
  if (!guilds || Object.keys(guilds).length === 0) {
    return null;
  }
  const space = groupSpace?.trim() ?? "";
  if (space && guilds[space]) {
    return guilds[space];
  }
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) {
    return guilds[normalized];
  }
  if (normalized) {
    const match = Object.values(guilds).find(
      (entry) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) {
      return match;
    }
  }
  return guilds["*"] ?? null;
}

function resolveDiscordChannelEntry<TEntry>(
  channelEntries: Record<string, TEntry> | undefined,
  params: { groupId?: string | null; groupChannel?: string | null },
): TEntry | undefined {
  if (!channelEntries || Object.keys(channelEntries).length === 0) {
    return undefined;
  }
  const groupChannel = params.groupChannel;
  const channelSlug = normalizeDiscordSlug(groupChannel);
  return (
    (params.groupId ? channelEntries[params.groupId] : undefined) ??
    (channelSlug
      ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
      : undefined) ??
    (groupChannel ? channelEntries[normalizeDiscordSlug(groupChannel)] : undefined)
  );
}

type SlackChannelPolicyEntry = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

type SenderScopedToolsEntry = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

type ChannelGroupPolicyChannel =
  | "telegram"
  | "whatsapp"
  | "imessage"
  | "googlechat"
  | "bluebubbles";

function resolveSlackChannelPolicyEntry(
  params: GroupMentionParams,
): SlackChannelPolicyEntry | undefined {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const channels = (account.channels ?? {}) as Record<string, SlackChannelPolicyEntry>;
  if (Object.keys(channels).length === 0) {
    return undefined;
  }
  const channelId = params.groupId?.trim();
  const groupChannel = params.groupChannel;
  const channelName = groupChannel?.replace(/^#/, "");
  const normalizedName = normalizeHyphenSlug(channelName);
  const candidates = [
    channelId ?? "",
    channelName ? `#${channelName}` : "",
    channelName ?? "",
    normalizedName,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && channels[candidate]) {
      return channels[candidate];
    }
  }
  return channels["*"];
}

function resolveChannelRequireMention(
  params: GroupMentionParams,
  channel: ChannelGroupPolicyChannel,
  groupId: string | null | undefined = params.groupId,
): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel,
    groupId,
    accountId: params.accountId,
  });
}

function resolveChannelToolPolicyForSender(
  params: GroupMentionParams,
  channel: ChannelGroupPolicyChannel,
  groupId: string | null | undefined = params.groupId,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel,
    groupId,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}

function resolveSenderToolsEntry(
  entry: SenderScopedToolsEntry | undefined | null,
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  if (!entry) {
    return undefined;
  }
  const senderPolicy = resolveToolsBySender({
    toolsBySender: entry.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (senderPolicy) {
    return senderPolicy;
  }
  return entry.tools;
}

function resolveDiscordPolicyContext(params: GroupMentionParams) {
  const guildEntry = resolveDiscordGuildEntry(
    params.cfg.channels?.discord?.guilds,
    params.groupSpace,
  );
  const channelEntries = guildEntry?.channels;
  const channelEntry =
    channelEntries && Object.keys(channelEntries).length > 0
      ? resolveDiscordChannelEntry(channelEntries, params)
      : undefined;
  return { guildEntry, channelEntry };
}

export function resolveTelegramGroupRequireMention(
  params: GroupMentionParams,
): boolean | undefined {
  const { chatId, topicId } = parseTelegramGroupId(params.groupId);
  const requireMention = resolveTelegramRequireMention({
    cfg: params.cfg,
    chatId,
    topicId,
  });
  if (typeof requireMention === "boolean") {
    return requireMention;
  }
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "telegram",
    groupId: chatId ?? params.groupId,
    accountId: params.accountId,
  });
}

export function resolveWhatsAppGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "whatsapp");
}

export function resolveIMessageGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "imessage");
}

export function resolveDiscordGroupRequireMention(params: GroupMentionParams): boolean {
  const context = resolveDiscordPolicyContext(params);
  if (typeof context.channelEntry?.requireMention === "boolean") {
    return context.channelEntry.requireMention;
  }
  if (typeof context.guildEntry?.requireMention === "boolean") {
    return context.guildEntry.requireMention;
  }
  return true;
}

export function resolveGoogleChatGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "googlechat");
}

export function resolveGoogleChatGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "googlechat");
}

export function resolveSlackGroupRequireMention(params: GroupMentionParams): boolean {
  const resolved = resolveSlackChannelPolicyEntry(params);
  if (typeof resolved?.requireMention === "boolean") {
    return resolved.requireMention;
  }
  return true;
}

export function resolveBlueBubblesGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelRequireMention(params, "bluebubbles");
}

export function resolveTelegramGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const { chatId } = parseTelegramGroupId(params.groupId);
  return resolveChannelToolPolicyForSender(params, "telegram", chatId ?? params.groupId);
}

export function resolveWhatsAppGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "whatsapp");
}

export function resolveIMessageGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "imessage");
}

export function resolveDiscordGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const context = resolveDiscordPolicyContext(params);
  const channelPolicy = resolveSenderToolsEntry(context.channelEntry, params);
  if (channelPolicy) {
    return channelPolicy;
  }
  return resolveSenderToolsEntry(context.guildEntry, params);
}

export function resolveSlackGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const resolved = resolveSlackChannelPolicyEntry(params);
  return resolveSenderToolsEntry(resolved, params);
}

export function resolveBlueBubblesGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  return resolveChannelToolPolicyForSender(params, "bluebubbles");
}
