import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { captureChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { buildDirectoryCacheKey, DirectoryCache } from "./directory-cache.js";
// Message CLI actions use scoped registries without activating the process-root registry.
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";
import {
  ambiguousTargetError,
  missingTargetError,
  reservedTargetLiteralError,
  unknownTargetError,
} from "./target-errors.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
  resolveReservedTargetLiteral,
  stripNormalizedTargetProviderPrefixes,
  type ResolvedPluginMessagingTarget,
} from "./target-normalization.js";

export type ResolvedMessagingTarget = Omit<ResolvedPluginMessagingTarget, "resolutionSource"> & {
  resolutionSource: "plugin" | "directory" | "normalized";
};

type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

export function resetDirectoryCache(params?: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}) {
  if (!params) {
    directoryCache.clear();
    return;
  }
  const channelKey = params.channel;
  const accountKey = params.accountId ?? "default";
  directoryCache.clearMatching(
    (key) =>
      key.startsWith(`${channelKey}:`) &&
      (!params.accountId || key.startsWith(`${channelKey}:${accountKey}:`)),
    params.cfg,
  );
}

function stripTargetPrefixes(value: string, channel?: ChannelId, plugin?: ChannelPlugin): string {
  const providerPrefixes = [channel, plugin?.id, ...(plugin?.messaging?.targetPrefixes ?? [])]
    .map((prefix) => prefix?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  return stripNormalizedTargetProviderPrefixes(value, providerPrefixes)
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
  const plugin = getRuntimeVisibleChannelPlugin(params.channel);
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
    (lowered.startsWith("user:") ? "user" : lowered.startsWith("channel:") ? "group" : undefined);

  if (display) {
    if (display.startsWith("#") || display.startsWith("@")) {
      return display;
    }
    if (kind === "user") {
      return `@${display}`;
    }
    if (kind === "group" || kind === "channel") {
      return `#${display}`;
    }
    return display;
  }

  if (!trimmedTarget) {
    return trimmedTarget;
  }
  if (trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) {
    return trimmedTarget;
  }

  const channelPrefix = `${params.channel}:`;
  const withoutProvider = lowered.startsWith(channelPrefix)
    ? trimmedTarget.slice(channelPrefix.length)
    : trimmedTarget;

  if (/^channel:/i.test(withoutProvider)) {
    return `#${withoutProvider.replace(/^channel:/i, "")}`;
  }
  if (/^user:/i.test(withoutProvider)) {
    return `@${withoutProvider.replace(/^user:/i, "")}`;
  }
  return withoutProvider;
}

function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: ChannelDirectoryEntryKind,
  plugin?: ChannelPlugin,
): ChannelDirectoryEntryKind {
  if (preferred) {
    return preferred;
  }
  const inferredChatType = (
    plugin ?? getRuntimeVisibleChannelPlugin(channel)
  )?.messaging?.inferTargetChatType?.({
    to: raw,
  });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel" || inferredChatType === "group") {
    return inferredChatType;
  }

  if (raw.startsWith("@") || /^<@!?/.test(raw) || /^user:/i.test(raw)) {
    return "user";
  }
  if (raw.startsWith("#") || /^channel:/i.test(raw)) {
    return "group";
  }

  const chatTypes = plugin?.capabilities?.chatTypes ?? [];
  if (chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct")) {
    return "user";
  }

  return "group";
}

function normalizeDirectoryEntryId(
  channel: ChannelId,
  entry: ChannelDirectoryEntry,
  plugin?: ChannelPlugin,
): string {
  const normalized = normalizeTargetForProvider(channel, entry.id, plugin);
  return normalized ?? entry.id.trim();
}

async function getDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  query?: string;
  runtime?: RuntimeEnv;
  preferLiveOnMiss?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ChannelDirectoryEntry[]> {
  const signature = buildTargetResolverSignature(params.channel, params.plugin);
  const cacheQuery = normalizeLowercaseStringOrEmpty(params.query ?? "");
  const cacheKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    signature,
    query: cacheQuery,
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  const listEntries = async (useLive: boolean): Promise<ChannelDirectoryEntry[]> => {
    const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
    const directory = plugin?.directory;
    if (!directory) {
      return [];
    }
    const runtime = params.runtime ?? defaultRuntime;
    const fn =
      params.kind === "user"
        ? useLive
          ? (directory.listPeersLive ?? directory.listPeers)
          : directory.listPeers
        : useLive
          ? (directory.listGroupsLive ?? directory.listGroups)
          : directory.listGroups;
    if (!fn) {
      return [];
    }
    captureChannelReadAuthority()?.();
    return await fn({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
      query: params.query ?? undefined,
      limit: undefined,
      runtime,
    });
  };
  let entries = await listEntries(false);
  if (entries.length === 0 && params.preferLiveOnMiss) {
    // Empty directory results get one live lookup before caching the final result.
    entries = await listEntries(true);
  }
  directoryCache.set(cacheKey, entries, params.cfg);
  return entries;
}

export async function resolveChannelTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  unknownTargetMode?: "error" | "normalized";
  plugin?: ChannelPlugin;
}): Promise<ResolveMessagingTargetResult> {
  const raw = params.input.trim();
  if (!raw) {
    const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
    return {
      ok: false,
      error: missingTargetError(
        plugin?.meta?.label ?? params.channel,
        plugin?.messaging?.targetResolver?.hint,
      ),
    };
  }
  const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
  const providerLabel = plugin?.meta?.label ?? params.channel;
  const hint = plugin?.messaging?.targetResolver?.hint;
  const kind = detectTargetKind(params.channel, raw, params.preferredKind, plugin);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw, plugin);
  const normalized = normalizedInput?.normalized ?? raw;
  const reservedLiteral = resolveReservedTargetLiteral({ raw, plugin });
  const normalizedResult = (): ResolveMessagingTargetResult => ({
    ok: true,
    target: {
      to: normalized,
      kind,
      display: stripTargetPrefixes(normalized),
      source: "normalized",
      resolutionSource: "normalized",
    },
  });
  const resolvePluginTarget = (requireIdLike?: boolean) =>
    maybeResolvePluginMessagingTarget({ ...params, input: raw, plugin, requireIdLike });
  if (
    normalizedInput &&
    !reservedLiteral &&
    looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized,
      plugin,
    })
  ) {
    const target = await resolvePluginTarget(true);
    return target ? { ok: true, target } : normalizedResult();
  }
  const query = stripTargetPrefixes(raw, params.channel, plugin);
  const entries = await getDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: kind === "user" ? "user" : "group",
    query,
    runtime: params.runtime,
    preferLiveOnMiss: true,
    plugin,
  });
  const normalizedQuery = query.toLowerCase();
  const matches = normalizedQuery
    ? entries.filter((entry) => {
        const candidates = [
          normalizeDirectoryEntryId(params.channel, entry, plugin),
          entry.name,
          entry.handle,
        ].map((value) =>
          value ? stripTargetPrefixes(value, params.channel, plugin).toLowerCase() : "",
        );
        return candidates.some((value) =>
          reservedLiteral ? value === normalizedQuery : value.includes(normalizedQuery),
        );
      })
    : [];
  const [entry] = matches;
  if (matches.length === 1 && entry) {
    return {
      ok: true,
      target: {
        to: normalizeDirectoryEntryId(params.channel, entry, plugin),
        kind,
        display:
          entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id, params.channel, plugin),
        source: "directory",
        resolutionSource: "directory",
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: ambiguousTargetError(providerLabel, raw, hint),
      candidates: matches,
    };
  }
  // Directory misses are the fail-closed boundary for reserved literals.
  if (reservedLiteral) {
    return { ok: false, error: reservedTargetLiteralError(providerLabel, reservedLiteral, hint) };
  }
  const resolvedFallbackTarget = await resolvePluginTarget();
  if (resolvedFallbackTarget) {
    return {
      ok: true,
      target: resolvedFallbackTarget,
    };
  }

  if (params.unknownTargetMode === "normalized") {
    return normalizedResult();
  }

  return {
    ok: false,
    error: unknownTargetError(providerLabel, raw, hint),
  };
}

export async function lookupDirectoryDisplay(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;

  // Targets can resolve to either peers (DMs) or groups. Try both.
  const directories = await Promise.all(
    (["group", "user"] as const).map((kind) =>
      getDirectoryEntries({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        kind,
        runtime: params.runtime,
        preferLiveOnMiss: false,
      }),
    ),
  );
  for (const entries of directories) {
    const entry = entries.find(
      (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
    );
    if (entry) {
      return entry.name ?? entry.handle ?? undefined;
    }
  }
  return undefined;
}
