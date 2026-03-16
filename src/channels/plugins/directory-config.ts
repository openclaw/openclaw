import type { OpenClawConfig } from "../../config/types.js";
import { mapAllowFromEntries } from "../../plugin-sdk/channel-config-helpers.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import type { InspectedDiscordAccount } from "../read-only-account-inspect.discord.runtime.js";
import { inspectReadOnlyChannelAccount } from "../read-only-account-inspect.js";
import type { InspectedSlackAccount } from "../read-only-account-inspect.slack.runtime.js";
import type { InspectedTelegramAccount } from "../read-only-account-inspect.telegram.runtime.js";
import { applyDirectoryQueryAndLimit, toDirectoryEntries } from "./directory-config-helpers.js";
import { normalizeSlackMessagingTarget } from "./normalize/slack.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelDirectoryEntry } from "./types.js";

export type DirectoryConfigParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function addAllowFromAndDmsIds(
  ids: Set<string>,
  allowFrom: readonly unknown[] | undefined,
  dms: Record<string, unknown> | undefined,
) {
  for (const entry of allowFrom ?? []) {
    const raw = String(entry).trim();
    if (!raw || raw === "*") {
      continue;
    }
    ids.add(raw);
  }
  addTrimmedEntries(ids, Object.keys(dms ?? {}));
}

function addTrimmedId(ids: Set<string>, value: unknown) {
  const trimmed = String(value).trim();
  if (trimmed) {
    ids.add(trimmed);
  }
}

function addTrimmedEntries(ids: Set<string>, values: Iterable<unknown>) {
  for (const value of values) {
    addTrimmedId(ids, value);
  }
}

function normalizeTrimmedSet(
  ids: Set<string>,
  normalize: (raw: string) => string | null,
): string[] {
  return Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalize(raw))
    .filter((id): id is string => Boolean(id));
}

export async function listSlackDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "slack",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedSlackAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const ids = new Set<string>();

  addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.dm?.allowFrom, account.config.dms);
  for (const channel of Object.values(account.config.channels ?? {})) {
    addTrimmedEntries(ids, channel.users ?? []);
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
    const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
    if (!normalizedUserId) {
      return null;
    }
    const target = `user:${normalizedUserId}`;
    return normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
  }).filter((id) => id.startsWith("user:"));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listSlackDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "slack",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedSlackAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const ids = Object.keys(account.config.channels ?? {})
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizeSlackMessagingTarget(raw) ?? raw.toLowerCase())
    .filter((id) => id.startsWith("channel:"));
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export async function listDiscordDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "discord",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedDiscordAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const ids = new Set<string>();

  addAllowFromAndDmsIds(
    ids,
    account.config.allowFrom ?? account.config.dm?.allowFrom,
    account.config.dms,
  );
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, guild.users ?? []);
    for (const channel of Object.values(guild.channels ?? {})) {
      addTrimmedEntries(ids, channel.users ?? []);
    }
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<@!?(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `user:${cleaned}`;
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listDiscordDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "discord",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedDiscordAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const ids = new Set<string>();
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, Object.keys(guild.channels ?? {}));
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<#(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `channel:${cleaned}`;
  });
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listTelegramDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "telegram",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedTelegramAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const raw = [
    ...mapAllowFromEntries(account.config.allowFrom),
    ...Object.keys(account.config.dms ?? {}),
  ];
  const ids = Array.from(
    new Set(
      raw
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram|tg):/i, "")),
    ),
  )
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      return withAt;
    })
    .filter((id): id is string => Boolean(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listTelegramDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "telegram",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedTelegramAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  const ids = Object.keys(account.config.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export async function listWhatsAppDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = getChannelPlugin("whatsapp")?.config.resolveAccount(
    params.cfg,
    params.accountId,
  ) as { allowFrom?: unknown[] } | null | undefined;
  if (!account || typeof account !== "object") {
    return [];
  }
  const ids = (account.allowFrom ?? [])
    .map((entry: unknown) => String(entry).trim())
    .filter((entry) => Boolean(entry) && entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry) ?? "")
    .filter(Boolean)
    .filter((id) => !isWhatsAppGroupJid(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listWhatsAppDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = getChannelPlugin("whatsapp")?.config.resolveAccount(
    params.cfg,
    params.accountId,
  ) as { groups?: Record<string, unknown> } | null | undefined;
  if (!account || typeof account !== "object") {
    return [];
  }
  const ids = Object.keys(account.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
