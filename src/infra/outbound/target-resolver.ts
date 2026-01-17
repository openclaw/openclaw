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

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function stripTargetPrefixes(value: string): string {
  return value
    .replace(/^(channel|group|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
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

function looksLikeId(channel: ChannelId, normalized: string): boolean {
  if (!normalized) return false;
  const raw = normalized.trim();
  switch (channel) {
    case "discord": {
      const candidate = stripTargetPrefixes(raw);
      return /^\d{6,}$/.test(candidate);
    }
    case "slack": {
      const candidate = stripTargetPrefixes(raw);
      return /^[A-Z0-9]{8,}$/i.test(candidate);
    }
    case "msteams": {
      return /^conversation:/i.test(raw) || /^user:/i.test(raw) || raw.includes("@thread");
    }
    case "telegram": {
      return /^telegram:/i.test(raw) || raw.startsWith("@");
    }
    case "whatsapp": {
      const candidate = stripTargetPrefixes(raw);
      return (
        /@/i.test(candidate) ||
        /^\+?\d{3,}$/.test(candidate) ||
        candidate.toLowerCase().endsWith("@g.us")
      );
    }
    default:
      return Boolean(raw);
  }
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
  if (looksLikeId(params.channel, normalized)) {
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
