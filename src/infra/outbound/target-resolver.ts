import { normalizeTargetForProvider } from "../../agents/pi-embedded-messaging.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { normalizeChannelTargetInput } from "./channel-target.js";
import { buildDirectoryCacheKey, DirectoryCache } from "./directory-cache.js";

export type TargetResolveKind = ChannelDirectoryEntryKind | "channel";

export type ResolvedMessagingTarget = {
  to: string;
  kind: TargetResolveKind;
  display?: string;
  source: "normalized" | "directory";
};

export type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

export async function resolveChannelTarget(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ResolveMessagingTargetResult> {
  return resolveMessagingTarget(params);
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

export function resetDirectoryCache(params?: { channel?: ChannelId; accountId?: string | null }) {
  if (!params?.channel) {
    directoryCache.clear();
    return;
  }
  const channelKey = params.channel;
  const accountKey = params.accountId ?? "default";
  directoryCache.clearMatching((key) => {
    if (!key.startsWith(`${channelKey}:`)) return false;
    if (!params.accountId) return true;
    return key.startsWith(`${channelKey}:${accountKey}:`);
  });
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function stripTargetPrefixes(value: string): string {
  return value
    .replace(/^(channel|group|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
}

export function formatTargetDisplay(params: {
  channel: ChannelId;
  target: string;
  display?: string;
  kind?: ChannelDirectoryEntryKind;
}): string {
  const plugin = getChannelPlugin(params.channel);
  if (plugin?.messaging?.formatTargetDisplay) {
    return plugin.messaging.formatTargetDisplay({
      target: params.target,
      display: params.display,
      kind: params.kind,
    });
  }

  const trimmedTarget = params.target.trim();
  const lowered = trimmedTarget.toLowerCase();
  const display = params.display?.trim();
  const kind =
    params.kind ??
    (lowered.startsWith("user:")
      ? "user"
      : lowered.startsWith("channel:") || lowered.startsWith("group:")
        ? "group"
        : undefined);

  if (display) {
    if (display.startsWith("#") || display.startsWith("@")) return display;
    if (kind === "user") return `@${display}`;
    if (kind === "group" || kind === "channel") return `#${display}`;
    return display;
  }

  if (!trimmedTarget) return trimmedTarget;
  if (trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) return trimmedTarget;

  const withoutPrefix = trimmedTarget.replace(/^telegram:/i, "");
  if (/^(channel|group):/i.test(withoutPrefix)) {
    return `#${withoutPrefix.replace(/^(channel|group):/i, "")}`;
  }
  if (/^user:/i.test(withoutPrefix)) {
    return `@${withoutPrefix.replace(/^user:/i, "")}`;
  }
  return withoutPrefix;
}

function preserveTargetCase(channel: ChannelId, raw: string, normalized: string): string {
  if (channel !== "slack") return normalized;
  const trimmed = raw.trim();
  if (/^channel:/i.test(trimmed) || /^user:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#")) return `channel:${trimmed.slice(1).trim()}`;
  if (trimmed.startsWith("@")) return `user:${trimmed.slice(1).trim()}`;
  return trimmed;
}

function detectTargetKind(raw: string, preferred?: TargetResolveKind): TargetResolveKind {
  if (preferred) return preferred;
  const trimmed = raw.trim();
  if (!trimmed) return "group";
  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed) || /^user:/i.test(trimmed)) return "user";
  if (trimmed.startsWith("#") || /^channel:/i.test(trimmed) || /^group:/i.test(trimmed)) {
    return "group";
  }
  return "group";
}

function normalizeDirectoryEntryId(channel: ChannelId, entry: ChannelDirectoryEntry): string {
  const normalized = normalizeTargetForProvider(channel, entry.id);
  return normalized ?? entry.id.trim();
}

function matchesDirectoryEntry(params: {
  channel: ChannelId;
  entry: ChannelDirectoryEntry;
  query: string;
}): boolean {
  const query = normalizeQuery(params.query);
  if (!query) return false;
  const id = stripTargetPrefixes(normalizeDirectoryEntryId(params.channel, params.entry));
  const name = params.entry.name ? stripTargetPrefixes(params.entry.name) : "";
  const handle = params.entry.handle ? stripTargetPrefixes(params.entry.handle) : "";
  const candidates = [id, name, handle].map((value) => normalizeQuery(value)).filter(Boolean);
  return candidates.some((value) => value === query || value.includes(query));
}

function resolveMatch(params: {
  channel: ChannelId;
  entries: ChannelDirectoryEntry[];
  query: string;
}) {
  const matches = params.entries.filter((entry) =>
    matchesDirectoryEntry({ channel: params.channel, entry, query: params.query }),
  );
  if (matches.length === 0) return { kind: "none" as const };
  if (matches.length === 1) return { kind: "single" as const, entry: matches[0] };
  return { kind: "ambiguous" as const, entries: matches };
}

function looksLikeTargetId(params: {
  channel: ChannelId;
  raw: string;
  normalized: string;
}): boolean {
  const raw = params.raw.trim();
  if (!raw) return false;
  const plugin = getChannelPlugin(params.channel);
  const lookup = plugin?.messaging?.looksLikeTargetId;
  if (lookup) return lookup(raw, params.normalized);
  if (/^(channel|group|user):/i.test(raw)) return true;
  if (/^[@#]/.test(raw)) return true;
  if (/^\+?\d{6,}$/.test(raw)) return true;
  if (raw.includes("@thread")) return true;
  if (/^(conversation|user):/i.test(raw)) return true;
  return false;
}

async function listDirectoryEntries(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  query?: string;
  source: "cache" | "live";
}): Promise<ChannelDirectoryEntry[]> {
  const plugin = getChannelPlugin(params.channel);
  const directory = plugin?.directory;
  if (!directory) return [];
  const runtime = params.runtime ?? defaultRuntime;
  const useLive = params.source === "live";
  if (params.kind === "user") {
    const fn = useLive ? (directory.listPeersLive ?? directory.listPeers) : directory.listPeers;
    if (!fn) return [];
    return await fn({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      query: params.query ?? undefined,
      limit: undefined,
      runtime,
    });
  }
  const fn = useLive ? (directory.listGroupsLive ?? directory.listGroups) : directory.listGroups;
  if (!fn) return [];
  return await fn({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    query: params.query ?? undefined,
    limit: undefined,
    runtime,
  });
}

async function getDirectoryEntries(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  query?: string;
  runtime?: RuntimeEnv;
  preferLiveOnMiss?: boolean;
}): Promise<ChannelDirectoryEntry[]> {
  const cacheKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "cache",
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) return cached;
  const entries = await listDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    query: params.query,
    runtime: params.runtime,
    source: "cache",
  });
  if (entries.length > 0 || !params.preferLiveOnMiss) {
    directoryCache.set(cacheKey, entries, params.cfg);
    return entries;
  }
  const liveKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "live",
  });
  const liveEntries = await listDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    query: params.query,
    runtime: params.runtime,
    source: "live",
  });
  directoryCache.set(liveKey, liveEntries, params.cfg);
  directoryCache.set(cacheKey, liveEntries, params.cfg);
  return liveEntries;
}

export async function resolveMessagingTarget(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ResolveMessagingTargetResult> {
  const raw = normalizeChannelTargetInput(params.input);
  if (!raw) {
    return { ok: false, error: new Error("Target is required") };
  }
  const kind = detectTargetKind(raw, params.preferredKind);
  const normalized = normalizeTargetForProvider(params.channel, raw) ?? raw;
  if (looksLikeTargetId({ channel: params.channel, raw, normalized })) {
    const directTarget = preserveTargetCase(params.channel, raw, normalized);
    return {
      ok: true,
      target: {
        to: directTarget,
        kind,
        display: stripTargetPrefixes(raw),
        source: "normalized",
      },
    };
  }
  const query = stripTargetPrefixes(raw);
  const entries = await getDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: kind === "user" ? "user" : "group",
    query,
    runtime: params.runtime,
    preferLiveOnMiss: true,
  });
  const match = resolveMatch({ channel: params.channel, entries, query });
  if (match.kind === "single") {
    const entry = match.entry;
    return {
      ok: true,
      target: {
        to: normalizeDirectoryEntryId(params.channel, entry),
        kind,
        display: entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id),
        source: "directory",
      },
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: new Error(`Ambiguous target "${raw}". Provide a unique name or an explicit id.`),
      candidates: match.entries,
    };
  }
  return {
    ok: false,
    error: new Error(`Unknown target "${raw}" for ${params.channel}.`),
  };
}

export async function lookupDirectoryDisplay(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;
  const candidates = await getDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: "group",
    runtime: params.runtime,
    preferLiveOnMiss: false,
  });
  const entry = candidates.find(
    (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
  );
  return entry?.name ?? entry?.handle ?? undefined;
}
