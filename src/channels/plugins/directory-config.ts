import { listAgentIds } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveDiscordAccount } from "../../discord/accounts.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { listObservedTelegramGroups } from "../../telegram/observed-groups.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import { normalizeSlackMessagingTarget } from "./normalize/slack.js";
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
  for (const id of Object.keys(dms ?? {})) {
    const trimmed = id.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }
}

function resolveDirectoryQuery(query?: string | null): string {
  return query?.trim().toLowerCase() || "";
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

function applyDirectoryQueryAndLimit(ids: string[], params: DirectoryConfigParams): string[] {
  const q = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);
  const filtered = ids.filter((id) => (q ? id.toLowerCase().includes(q) : true));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[] {
  return ids.map((id) => ({ kind, id }) as const);
}

function resolveTelegramGroupIdFromSession(params: { key: string; groupId?: string | null }) {
  const fromEntry = params.groupId?.trim();
  if (fromEntry && /^-\d+$/.test(fromEntry)) {
    return fromEntry;
  }

  const rawKey = parseAgentSessionKey(params.key)?.rest ?? params.key.trim();
  const match = rawKey.match(/^telegram:(group|channel):([^:]+)/i);
  const groupId = match?.[2]?.trim() ?? "";
  return /^-\d+$/.test(groupId) ? groupId : null;
}

function resolveTelegramSessionGroupName(entry: {
  subject?: string;
  origin?: { label?: string };
  displayName?: string;
}) {
  const subject = entry.subject?.trim();
  if (subject) {
    return subject;
  }

  const label = entry.origin?.label?.trim();
  if (label) {
    return label.replace(/\s+id:-?\d+\s*$/i, "").trim() || label;
  }

  const displayName = entry.displayName?.trim();
  return displayName || undefined;
}

async function listTelegramDirectoryGroupsFromSessions(
  params: DirectoryConfigParams & { resolvedAccountId: string },
): Promise<ChannelDirectoryEntry[]> {
  const accountId = params.resolvedAccountId.trim().toLowerCase();
  const byId = new Map<
    string,
    ChannelDirectoryEntry & {
      updatedAt?: number;
    }
  >();

  for (const agentId of listAgentIds(params.cfg)) {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath);
    } catch {
      continue;
    }

    for (const [key, entry] of Object.entries(store)) {
      const groupId = resolveTelegramGroupIdFromSession({
        key,
        groupId: typeof entry.groupId === "string" ? entry.groupId : null,
      });
      if (!groupId) {
        continue;
      }

      const sessionAccountId =
        typeof entry.lastAccountId === "string"
          ? entry.lastAccountId.trim().toLowerCase()
          : typeof entry.origin?.accountId === "string"
            ? entry.origin.accountId.trim().toLowerCase()
            : "";
      if (sessionAccountId && sessionAccountId !== accountId) {
        continue;
      }

      const next: ChannelDirectoryEntry & { updatedAt?: number } = {
        kind: "group",
        id: groupId,
        name: resolveTelegramSessionGroupName({
          subject: typeof entry.subject === "string" ? entry.subject : undefined,
          origin: entry.origin?.label ? { label: entry.origin.label } : undefined,
          displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
        }),
        raw: {
          source: "session",
          sessionKey: key,
        },
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
      };

      const existing = byId.get(groupId);
      if (!existing) {
        byId.set(groupId, next);
        continue;
      }

      const existingUpdatedAt = existing.updatedAt ?? 0;
      const nextUpdatedAt = next.updatedAt ?? 0;
      if (nextUpdatedAt > existingUpdatedAt) {
        byId.set(groupId, {
          ...existing,
          ...next,
          name: next.name ?? existing.name,
        });
        continue;
      }

      if (!existing.name && next.name) {
        existing.name = next.name;
      }
    }
  }

  return Array.from(byId.values()).toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function listSlackDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();

  addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.dm?.allowFrom, account.config.dms);
  for (const channel of Object.values(account.config.channels ?? {})) {
    for (const user of channel.users ?? []) {
      const raw = String(user).trim();
      if (raw) {
        ids.add(raw);
      }
    }
  }

  const normalizedIds = Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
      const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
      if (!normalizedUserId) {
        return null;
      }
      const target = `user:${normalizedUserId}`;
      return normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
    })
    .filter((id): id is string => Boolean(id))
    .filter((id) => id.startsWith("user:"));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listSlackDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
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
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();

  addAllowFromAndDmsIds(
    ids,
    account.config.allowFrom ?? account.config.dm?.allowFrom,
    account.config.dms,
  );
  for (const guild of Object.values(account.config.guilds ?? {})) {
    for (const entry of guild.users ?? []) {
      const raw = String(entry).trim();
      if (raw) {
        ids.add(raw);
      }
    }
    for (const channel of Object.values(guild.channels ?? {})) {
      for (const user of channel.users ?? []) {
        const raw = String(user).trim();
        if (raw) {
          ids.add(raw);
        }
      }
    }
  }

  const normalizedIds = Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const mention = raw.match(/^<@!?(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
      if (!/^\d+$/.test(cleaned)) {
        return null;
      }
      return `user:${cleaned}`;
    })
    .filter((id): id is string => Boolean(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listDiscordDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();
  for (const guild of Object.values(account.config.guilds ?? {})) {
    for (const channelId of Object.keys(guild.channels ?? {})) {
      const trimmed = channelId.trim();
      if (trimmed) {
        ids.add(trimmed);
      }
    }
  }

  const normalizedIds = Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const mention = raw.match(/^<#(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
      if (!/^\d+$/.test(cleaned)) {
        return null;
      }
      return `channel:${cleaned}`;
    })
    .filter((id): id is string => Boolean(id));
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listTelegramDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const raw = [
    ...(account.config.allowFrom ?? []).map((entry) => String(entry)),
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
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const configuredIds = Object.keys(account.config.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  const observed = await listObservedTelegramGroups({
    accountId: account.accountId,
    query: null,
    limit: null,
  });
  const sessionGroups = await listTelegramDirectoryGroupsFromSessions({
    ...params,
    resolvedAccountId: account.accountId,
  });
  const observedById = new Map(observed.map((entry) => [entry.id, entry]));
  const sessionById = new Map(sessionGroups.map((entry) => [entry.id, entry]));
  const query = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);

  const enrich = (entry: ChannelDirectoryEntry): ChannelDirectoryEntry => {
    const observedEntry = observedById.get(entry.id);
    const sessionEntry = sessionById.get(entry.id);
    return {
      ...entry,
      name: entry.name ?? observedEntry?.name ?? sessionEntry?.name,
      handle: entry.handle ?? observedEntry?.handle,
      raw: entry.raw ?? observedEntry?.raw ?? sessionEntry?.raw,
    };
  };

  const merged = [
    ...configuredIds.map((id) =>
      enrich({
        kind: "group" as const,
        id,
      }),
    ),
    ...observed.filter((entry) => !configuredIds.includes(entry.id)).map((entry) => enrich(entry)),
    ...sessionGroups
      .filter((entry) => !configuredIds.includes(entry.id) && !observedById.has(entry.id))
      .map((entry) => enrich(entry)),
  ].filter((entry) => {
    if (!query) {
      return true;
    }
    return [entry.id, entry.name ?? "", entry.handle ?? ""].some((value) =>
      value.toLowerCase().includes(query),
    );
  });

  return typeof limit === "number" ? merged.slice(0, limit) : merged;
}

export async function listWhatsAppDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = (account.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => Boolean(entry) && entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry) ?? "")
    .filter(Boolean)
    .filter((id) => !isWhatsAppGroupJid(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listWhatsAppDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = Object.keys(account.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
