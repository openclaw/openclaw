import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../../channels/allowlists/resolve-utils.js";
import type { DiscordGuildEntry } from "../../config/types.discord.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveDiscordChannelAllowlist } from "../resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../resolve-users.js";

type GuildEntries = Record<string, DiscordGuildEntry>;
type ChannelResolutionInput = { input: string; guildKey: string; channelKey?: string };

function toGuildEntries(value: unknown): GuildEntries {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: GuildEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    out[key] = entry as DiscordGuildEntry;
  }
  return out;
}

function toAllowlistEntries(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry));
}

function hasGuildEntries(value: GuildEntries): boolean {
  return Object.keys(value).length > 0;
}

function collectChannelResolutionInputs(guildEntries: GuildEntries): ChannelResolutionInput[] {
  const entries: ChannelResolutionInput[] = [];
  for (const [guildKey, guildCfg] of Object.entries(guildEntries)) {
    if (guildKey === "*") {
      continue;
    }
    const channels = guildCfg?.channels ?? {};
    const channelKeys = Object.keys(channels).filter((key) => key !== "*");
    if (channelKeys.length === 0) {
      const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
      entries.push({ input, guildKey });
      continue;
    }
    for (const channelKey of channelKeys) {
      entries.push({
        input: `${guildKey}/${channelKey}`,
        guildKey,
        channelKey,
      });
    }
  }
  return entries;
}

async function resolveGuildEntriesByChannelAllowlist(params: {
  token: string;
  guildEntries: GuildEntries;
  fetcher: typeof fetch;
  runtime: RuntimeEnv;
}): Promise<GuildEntries> {
  const entries = collectChannelResolutionInputs(params.guildEntries);
  if (entries.length === 0) {
    return params.guildEntries;
  }
  try {
    const resolved = await resolveDiscordChannelAllowlist({
      token: params.token,
      entries: entries.map((entry) => entry.input),
      fetcher: params.fetcher,
    });
    const sourceByInput = new Map(entries.map((entry) => [entry.input, entry]));
    const nextGuilds = { ...params.guildEntries };
    const mapping: string[] = [];
    const unresolved: string[] = [];
    for (const entry of resolved) {
      const source = sourceByInput.get(entry.input);
      if (!source) {
        continue;
      }
      const sourceGuild = params.guildEntries[source.guildKey] ?? {};
      if (!entry.resolved || !entry.guildId) {
        unresolved.push(entry.input);
        continue;
      }
      mapping.push(
        entry.channelId
          ? `${entry.input}→${entry.guildId}/${entry.channelId}`
          : `${entry.input}→${entry.guildId}`,
      );
      const existing = nextGuilds[entry.guildId] ?? {};
      const mergedChannels = {
        ...sourceGuild.channels,
        ...existing.channels,
      };
      const mergedGuild: DiscordGuildEntry = {
        ...sourceGuild,
        ...existing,
        channels: mergedChannels,
      };
      nextGuilds[entry.guildId] = mergedGuild;

      if (source.channelKey && entry.channelId) {
        const sourceChannel = sourceGuild.channels?.[source.channelKey];
        if (sourceChannel) {
          nextGuilds[entry.guildId] = {
            ...mergedGuild,
            channels: {
              ...mergedChannels,
              [entry.channelId]: {
                ...sourceChannel,
                ...mergedChannels[entry.channelId],
              },
            },
          };
        }
      }
    }
    summarizeMapping("discord channels", mapping, unresolved, params.runtime);
    return nextGuilds;
  } catch (err) {
    params.runtime.log?.(
      `discord channel resolve failed; using config entries. ${formatErrorMessage(err)}`,
    );
    return params.guildEntries;
  }
}

async function resolveAllowFromByUserAllowlist(params: {
  token: string;
  allowFrom: string[] | undefined;
  fetcher: typeof fetch;
  runtime: RuntimeEnv;
}): Promise<string[] | undefined> {
  const allowEntries =
    params.allowFrom?.filter((entry) => String(entry).trim() && String(entry).trim() !== "*") ?? [];
  if (allowEntries.length === 0) {
    return params.allowFrom;
  }
  try {
    const resolvedUsers = await resolveDiscordUserAllowlist({
      token: params.token,
      entries: allowEntries.map((entry) => String(entry)),
      fetcher: params.fetcher,
    });
    const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(resolvedUsers);
    const allowFrom = canonicalizeAllowlistWithResolvedIds({
      existing: params.allowFrom,
      resolvedMap,
    });
    summarizeMapping("discord users", mapping, unresolved, params.runtime);
    return allowFrom;
  } catch (err) {
    params.runtime.log?.(
      `discord user resolve failed; using config entries. ${formatErrorMessage(err)}`,
    );
    return params.allowFrom;
  }
}

function collectGuildUserEntries(guildEntries: GuildEntries): Set<string> {
  const userEntries = new Set<string>();
  for (const guild of Object.values(guildEntries)) {
    if (!guild || typeof guild !== "object") {
      continue;
    }
    addAllowlistUserEntriesFromConfigEntry(userEntries, guild);
    const channels = (guild as { channels?: Record<string, unknown> }).channels ?? {};
    for (const channel of Object.values(channels)) {
      addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
    }
  }
  return userEntries;
}

async function resolveGuildEntriesByUserAllowlist(params: {
  token: string;
  guildEntries: GuildEntries;
  fetcher: typeof fetch;
  runtime: RuntimeEnv;
}): Promise<GuildEntries> {
  const userEntries = collectGuildUserEntries(params.guildEntries);
  if (userEntries.size === 0) {
    return params.guildEntries;
  }
  try {
    const resolvedUsers = await resolveDiscordUserAllowlist({
      token: params.token,
      entries: Array.from(userEntries),
      fetcher: params.fetcher,
    });
    const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(resolvedUsers);
    const nextGuilds = { ...params.guildEntries };
    for (const [guildKey, guildConfig] of Object.entries(params.guildEntries)) {
      if (!guildConfig || typeof guildConfig !== "object") {
        continue;
      }
      const nextGuild = { ...guildConfig } as Record<string, unknown>;
      const users = (guildConfig as { users?: string[] }).users;
      if (Array.isArray(users) && users.length > 0) {
        nextGuild.users = canonicalizeAllowlistWithResolvedIds({
          existing: users,
          resolvedMap,
        });
      }
      const channels = (guildConfig as { channels?: Record<string, unknown> }).channels ?? {};
      if (channels && typeof channels === "object") {
        nextGuild.channels = patchAllowlistUsersInConfigEntries({
          entries: channels,
          resolvedMap,
          strategy: "canonicalize",
        });
      }
      nextGuilds[guildKey] = nextGuild as DiscordGuildEntry;
    }
    summarizeMapping("discord channel users", mapping, unresolved, params.runtime);
    return nextGuilds;
  } catch (err) {
    params.runtime.log?.(
      `discord channel user resolve failed; using config entries. ${formatErrorMessage(err)}`,
    );
    return params.guildEntries;
  }
}

export async function resolveDiscordAllowlistConfig(params: {
  token: string;
  guildEntries: unknown;
  allowFrom: unknown;
  fetcher: typeof fetch;
  runtime: RuntimeEnv;
}): Promise<{ guildEntries: GuildEntries | undefined; allowFrom: string[] | undefined }> {
  let guildEntries = toGuildEntries(params.guildEntries);
  let allowFrom = toAllowlistEntries(params.allowFrom);

  if (hasGuildEntries(guildEntries)) {
    guildEntries = await resolveGuildEntriesByChannelAllowlist({
      token: params.token,
      guildEntries,
      fetcher: params.fetcher,
      runtime: params.runtime,
    });
  }

  allowFrom = await resolveAllowFromByUserAllowlist({
    token: params.token,
    allowFrom,
    fetcher: params.fetcher,
    runtime: params.runtime,
  });

  if (hasGuildEntries(guildEntries)) {
    guildEntries = await resolveGuildEntriesByUserAllowlist({
      token: params.token,
      guildEntries,
      fetcher: params.fetcher,
      runtime: params.runtime,
    });
  }

  return {
    guildEntries: hasGuildEntries(guildEntries) ? guildEntries : undefined,
    allowFrom,
  };
}
