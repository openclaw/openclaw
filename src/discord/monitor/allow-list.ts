import type { Guild, User } from "@buape/carbon";
import type { AllowlistMatch } from "../../channels/allowlist-match.js";
import {
  buildChannelKeyCandidates,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig,
  type ChannelMatchSource,
} from "../../channels/channel-config.js";
import { formatDiscordUserTag } from "./format.js";

export type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};

export type DiscordAllowListMatch = AllowlistMatch<"wildcard" | "id" | "name" | "tag">;

export type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  reactionDelivery?: import("../../config/types.reactions.js").ReactionDelivery;
  reactionBundleWindowMs?: number;
  reactionIncludeMessage?: boolean;
  users?: string[];
  roles?: string[];
  channels?: Record<
    string,
    {
      allow?: boolean;
      requireMention?: boolean;
      skills?: string[];
      enabled?: boolean;
      users?: string[];
      roles?: string[];
      systemPrompt?: string;
      includeThreadStarter?: boolean;
      autoThread?: boolean;
    }
  >;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
  skills?: string[];
  enabled?: boolean;
  users?: string[];
  roles?: string[];
  systemPrompt?: string;
  includeThreadStarter?: boolean;
  autoThread?: boolean;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

export function normalizeDiscordAllowList(raw: string[] | undefined, prefixes: string[]) {
  if (!raw || raw.length === 0) {
    return null;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") {
      continue;
    }
    const normalized = normalizeDiscordSlug(text);
    const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
    if (/^\d+$/.test(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const prefix = prefixes.find((entry) => text.startsWith(entry));
    if (prefix) {
      const candidate = text.slice(prefix.length);
      if (candidate) {
        ids.add(candidate);
      }
      continue;
    }
    if (normalized) {
      names.add(normalized);
    }
  }
  return { allowAll, ids, names } satisfies DiscordAllowList;
}

export function normalizeDiscordSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function allowListMatches(
  list: DiscordAllowList,
  candidate: { id?: string; name?: string; tag?: string },
) {
  if (list.allowAll) {
    return true;
  }
  if (candidate.id && list.ids.has(candidate.id)) {
    return true;
  }
  const slug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (slug && list.names.has(slug)) {
    return true;
  }
  if (candidate.tag && list.names.has(normalizeDiscordSlug(candidate.tag))) {
    return true;
  }
  return false;
}

export function resolveDiscordAllowListMatch(params: {
  allowList: DiscordAllowList;
  candidate: { id?: string; name?: string; tag?: string };
}): DiscordAllowListMatch {
  const { allowList, candidate } = params;
  if (allowList.allowAll) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (candidate.id && allowList.ids.has(candidate.id)) {
    return { allowed: true, matchKey: candidate.id, matchSource: "id" };
  }
  const nameSlug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (nameSlug && allowList.names.has(nameSlug)) {
    return { allowed: true, matchKey: nameSlug, matchSource: "name" };
  }
  const tagSlug = candidate.tag ? normalizeDiscordSlug(candidate.tag) : "";
  if (tagSlug && allowList.names.has(tagSlug)) {
    return { allowed: true, matchKey: tagSlug, matchSource: "tag" };
  }
  return { allowed: false };
}

export function resolveDiscordUserAllowed(params: {
  allowList?: string[];
  userId: string;
  userName?: string;
  userTag?: string;
}) {
  const allowList = normalizeDiscordAllowList(params.allowList, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return true;
  }
  return allowListMatches(allowList, {
    id: params.userId,
    name: params.userName,
    tag: params.userTag,
  });
}

export function resolveDiscordRoleAllowed(params: {
  allowList?: string[];
  memberRoleIds: string[];
}) {
  // Role allowlists accept role IDs only. Names are ignored.
  const allowList = normalizeDiscordAllowList(params.allowList, ["role:"]);
  if (!allowList) {
    return true;
  }
  if (allowList.allowAll) {
    return true;
  }
  return params.memberRoleIds.some((roleId) => allowList.ids.has(roleId));
}

export function resolveDiscordMemberAllowed(params: {
  userAllowList?: string[];
  roleAllowList?: string[];
  memberRoleIds: string[];
  userId: string;
  userName?: string;
  userTag?: string;
}) {
  const hasUserRestriction = Array.isArray(params.userAllowList) && params.userAllowList.length > 0;
  const hasRoleRestriction = Array.isArray(params.roleAllowList) && params.roleAllowList.length > 0;
  if (!hasUserRestriction && !hasRoleRestriction) {
    return true;
  }
  const userOk = hasUserRestriction
    ? resolveDiscordUserAllowed({
        allowList: params.userAllowList,
        userId: params.userId,
        userName: params.userName,
        userTag: params.userTag,
      })
    : false;
  const roleOk = hasRoleRestriction
    ? resolveDiscordRoleAllowed({
        allowList: params.roleAllowList,
        memberRoleIds: params.memberRoleIds,
      })
    : false;
  return userOk || roleOk;
}

export function resolveDiscordMemberAccessState(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
}) {
  const channelUsers = params.channelConfig?.users ?? params.guildInfo?.users;
  const channelRoles = params.channelConfig?.roles ?? params.guildInfo?.roles;
  const hasAccessRestrictions =
    (Array.isArray(channelUsers) && channelUsers.length > 0) ||
    (Array.isArray(channelRoles) && channelRoles.length > 0);
  const memberAllowed = resolveDiscordMemberAllowed({
    userAllowList: channelUsers,
    roleAllowList: channelRoles,
    memberRoleIds: params.memberRoleIds,
    userId: params.sender.id,
    userName: params.sender.name,
    userTag: params.sender.tag,
  });
  return { channelUsers, channelRoles, hasAccessRestrictions, memberAllowed } as const;
}

export function resolveDiscordOwnerAllowFrom(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  sender: { id: string; name?: string; tag?: string };
}): string[] | undefined {
  const rawAllowList = params.channelConfig?.users ?? params.guildInfo?.users;
  if (!Array.isArray(rawAllowList) || rawAllowList.length === 0) {
    return undefined;
  }
  const allowList = normalizeDiscordAllowList(rawAllowList, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return undefined;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.sender.id,
      name: params.sender.name,
      tag: params.sender.tag,
    },
  });
  if (!match.allowed || !match.matchKey || match.matchKey === "*") {
    return undefined;
  }
  return [match.matchKey];
}

export function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: string[];
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
}) {
  if (!params.isDirectMessage) {
    return true;
  }
  const allowList = normalizeDiscordAllowList(params.allowFrom, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return true;
  }
  return allowListMatches(allowList, {
    id: params.author.id,
    name: params.author.username,
    tag: formatDiscordUserTag(params.author),
  });
}

export function resolveDiscordGuildEntry(params: {
  guild?: Guild<true> | Guild | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null {
  const guild = params.guild;
  const entries = params.guildEntries;
  if (!guild || !entries) {
    return null;
  }
  const byId = entries[guild.id];
  if (byId) {
    return { ...byId, id: guild.id };
  }
  const slug = normalizeDiscordSlug(guild.name ?? "");
  const bySlug = entries[slug];
  if (bySlug) {
    return { ...bySlug, id: guild.id, slug: slug || bySlug.slug };
  }
  const wildcard = entries["*"];
  if (wildcard) {
    return { ...wildcard, id: guild.id, slug: slug || wildcard.slug };
  }
  return null;
}

type DiscordChannelEntry = NonNullable<DiscordGuildEntryResolved["channels"]>[string];
type DiscordChannelLookup = {
  id: string;
  name?: string;
  slug?: string;
};
type DiscordChannelScope = "channel" | "thread";

function buildDiscordChannelKeys(
  params: DiscordChannelLookup & { allowNameMatch?: boolean },
): string[] {
  const allowNameMatch = params.allowNameMatch !== false;
  return buildChannelKeyCandidates(
    params.id,
    allowNameMatch ? params.slug : undefined,
    allowNameMatch ? params.name : undefined,
  );
}

function resolveDiscordChannelEntryMatch(
  channels: NonNullable<DiscordGuildEntryResolved["channels"]>,
  params: DiscordChannelLookup & { allowNameMatch?: boolean },
  parentParams?: DiscordChannelLookup,
) {
  const keys = buildDiscordChannelKeys(params);
  const parentKeys = parentParams ? buildDiscordChannelKeys(parentParams) : undefined;
  return resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys,
    parentKeys,
    wildcardKey: "*",
  });
}

function hasConfiguredDiscordChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): channels is NonNullable<DiscordGuildEntryResolved["channels"]> {
  return Boolean(channels && Object.keys(channels).length > 0);
}

function resolveDiscordChannelConfigEntry(
  entry: DiscordChannelEntry,
): DiscordChannelConfigResolved {
  const resolved: DiscordChannelConfigResolved = {
    allowed: entry.allow !== false,
    requireMention: entry.requireMention,
    skills: entry.skills,
    enabled: entry.enabled,
    users: entry.users,
    roles: entry.roles,
    systemPrompt: entry.systemPrompt,
    includeThreadStarter: entry.includeThreadStarter,
    autoThread: entry.autoThread,
  };
  return resolved;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channels = guildInfo?.channels;
  if (!hasConfiguredDiscordChannels(channels)) {
    return null;
  }
  const match = resolveDiscordChannelEntryMatch(channels, {
    id: channelId,
    name: channelName,
    slug: channelSlug,
  });
  const resolved = resolveChannelMatchConfig(match, resolveDiscordChannelConfigEntry);
  return resolved ?? { allowed: false };
}

export function resolveDiscordChannelConfigWithFallback(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: DiscordChannelScope;
}): DiscordChannelConfigResolved | null {
  const {
    guildInfo,
    channelId,
    channelName,
    channelSlug,
    parentId,
    parentName,
    parentSlug,
    scope,
  } = params;
  const channels = guildInfo?.channels;
  if (!hasConfiguredDiscordChannels(channels)) {
    return null;
  }
  const resolvedParentSlug = parentSlug ?? (parentName ? normalizeDiscordSlug(parentName) : "");
  const match = resolveDiscordChannelEntryMatch(
    channels,
    {
      id: channelId,
      name: channelName,
      slug: channelSlug,
      allowNameMatch: scope !== "thread",
    },
    parentId || parentName || parentSlug
      ? {
          id: parentId ?? "",
          name: parentName,
          slug: resolvedParentSlug,
        }
      : undefined,
  );
  return resolveChannelMatchConfig(match, resolveDiscordChannelConfigEntry) ?? { allowed: false };
}

export function resolveDiscordShouldRequireMention(params: {
  isGuildMessage: boolean;
  isThread: boolean;
  botId?: string | null;
  threadOwnerId?: string | null;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  /** Pass pre-computed value to avoid redundant checks. */
  isAutoThreadOwnedByBot?: boolean;
}): boolean {
  if (!params.isGuildMessage) {
    return false;
  }
  // Only skip mention requirement in threads created by the bot (when autoThread is enabled).
  const isBotThread = params.isAutoThreadOwnedByBot ?? isDiscordAutoThreadOwnedByBot(params);
  if (isBotThread) {
    return false;
  }
  return params.channelConfig?.requireMention ?? params.guildInfo?.requireMention ?? true;
}

export function isDiscordAutoThreadOwnedByBot(params: {
  isThread: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  botId?: string | null;
  threadOwnerId?: string | null;
}): boolean {
  if (!params.isThread) {
    return false;
  }
  if (!params.channelConfig?.autoThread) {
    return false;
  }
  const botId = params.botId?.trim();
  const threadOwnerId = params.threadOwnerId?.trim();
  return Boolean(botId && threadOwnerId && botId === threadOwnerId);
}

export function isDiscordGroupAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildAllowlisted: boolean;
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  const { groupPolicy, guildAllowlisted, channelAllowlistConfigured, channelAllowed } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  if (!guildAllowlisted) {
    return false;
  }
  if (!channelAllowlistConfigured) {
    return true;
  }
  return channelAllowed;
}

export function resolveGroupDmAllow(params: {
  channels?: string[];
  channelId: string;
  channelName?: string;
  channelSlug: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) {
    return true;
  }
  const allowList = new Set(channels.map((entry) => normalizeDiscordSlug(String(entry))));
  const candidates = [
    normalizeDiscordSlug(channelId),
    channelSlug,
    channelName ? normalizeDiscordSlug(channelName) : "",
  ].filter(Boolean);
  return allowList.has("*") || candidates.some((candidate) => allowList.has(candidate));
}

export function shouldEmitDiscordReactionNotification(params: {
  mode?: "off" | "own" | "all" | "allowlist";
  botId?: string;
  messageAuthorId?: string;
  userId: string;
  userName?: string;
  userTag?: string;
  allowlist?: string[];
}) {
  const mode = params.mode ?? "own";
  if (mode === "off") {
    return false;
  }
  if (mode === "all") {
    return true;
  }
  if (mode === "own") {
    return Boolean(params.botId && params.messageAuthorId === params.botId);
  }
  if (mode === "allowlist") {
    const list = normalizeDiscordAllowList(params.allowlist, ["discord:", "user:", "pk:"]);
    if (!list) {
      return false;
    }
    return allowListMatches(list, {
      id: params.userId,
      name: params.userName,
      tag: params.userTag,
    });
  }
  return false;
}
