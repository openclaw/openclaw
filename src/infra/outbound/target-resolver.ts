// Target resolver combines plugin id heuristics, cached directory searches,
// live fallback lookups, and normalized fallback targets.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
  ChannelOutboundTargetMode,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { captureChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { resolveBareTargetChannelNamespace } from "./channel-target-prefix.js";
import { buildDirectoryCacheKey, DirectoryCache } from "./directory-cache.js";
// Message CLI actions use scoped registries without activating the process-root registry.
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";
import {
  ambiguousTargetError,
  missingChannelDestinationError,
  missingTargetError,
  reservedTargetLiteralError,
  unknownTargetError,
} from "./target-errors.js";
import { maybeResolveIdLikeTarget } from "./target-id-resolution.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeChannelTargetInput,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
  resolveReservedTargetLiteral,
} from "./target-normalization.js";
import {
  buildNormalizedResolveResult,
  resolvePluginOutboundTarget,
  stripTargetPrefixes,
  type ResolvedMessagingTarget,
} from "./target-resolution-results.js";

export type { ResolvedMessagingTarget } from "./target-resolution-results.js";

/** Directory-backed destination kind used by outbound target resolution. */
type TargetResolveKind = ChannelDirectoryEntryKind | "channel";

/** Result of resolving a user-supplied outbound target. */
type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

export { maybeResolveIdLikeTarget } from "./target-id-resolution.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

/** Clears cached directory entries for all channels or one channel/account scope. */
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
  directoryCache.clearMatching((key) => {
    if (!key.startsWith(`${channelKey}:`)) {
      return false;
    }
    if (!params.accountId) {
      return true;
    }
    return key.startsWith(`${channelKey}:${accountKey}:`);
  }, params.cfg);
}

/** Formats a resolved target for user-facing summaries. */
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
  const lowered = normalizeLowercaseStringOrEmpty(trimmedTarget);
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
  preferred?: TargetResolveKind,
  plugin?: ChannelPlugin,
): TargetResolveKind {
  if (preferred) {
    return preferred;
  }
  const semanticKind = detectSemanticTargetKind(channel, raw, plugin);
  if (semanticKind) {
    return semanticKind;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "group";
  }
  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#")) {
    return "group";
  }

  return "group";
}

function detectSemanticTargetKind(
  channel: ChannelId,
  raw: string,
  plugin?: ChannelPlugin,
): TargetResolveKind | undefined {
  const inferredChatType = (
    plugin ?? getRuntimeVisibleChannelPlugin(channel)
  )?.messaging?.inferTargetChatType?.({ to: raw });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel") {
    return "channel";
  }
  if (inferredChatType === "group") {
    return "group";
  }

  const trimmed = raw.trim();
  if (/^user:/i.test(trimmed)) {
    return "user";
  }
  if (/^channel:/i.test(trimmed)) {
    return "channel";
  }
  if (/^group:/i.test(trimmed)) {
    return "group";
  }
  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#")) {
    return "group";
  }

  const chatTypes = plugin?.capabilities?.chatTypes ?? [];
  if (chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct")) {
    return "user";
  }

  return undefined;
}

function classifyPolicyRewrittenTarget(params: {
  channel: ChannelId;
  originalTo: string;
  originalKind: TargetResolveKind;
  resolvedTo: string;
  plugin?: ChannelPlugin;
}): TargetResolveKind {
  if (params.originalTo.trim() === params.resolvedTo.trim()) {
    return params.originalKind;
  }
  const semanticKind = detectSemanticTargetKind(params.channel, params.resolvedTo, params.plugin);
  if (semanticKind) {
    return semanticKind;
  }
  const originalIdentity = normalizeLowercaseStringOrEmpty(
    stripTargetPrefixes(params.originalTo, params.channel, params.plugin),
  );
  const resolvedIdentity = normalizeLowercaseStringOrEmpty(
    stripTargetPrefixes(params.resolvedTo, params.channel, params.plugin),
  );
  if (originalIdentity && originalIdentity === resolvedIdentity) {
    return params.originalKind;
  }
  return detectTargetKind(params.channel, params.resolvedTo, undefined, params.plugin);
}

function normalizeDirectoryEntryId(
  channel: ChannelId,
  entry: ChannelDirectoryEntry,
  plugin?: ChannelPlugin,
): string {
  const normalized = normalizeTargetForProvider(channel, entry.id, plugin);
  return normalized ?? entry.id.trim();
}

function matchesDirectoryEntry(params: {
  channel: ChannelId;
  entry: ChannelDirectoryEntry;
  query: string;
  plugin?: ChannelPlugin;
  exactOnly?: boolean;
}): boolean {
  const query = normalizeLowercaseStringOrEmpty(params.query);
  if (!query) {
    return false;
  }
  const id = stripTargetPrefixes(
    normalizeDirectoryEntryId(params.channel, params.entry, params.plugin),
    params.channel,
    params.plugin,
  );
  const name = params.entry.name
    ? stripTargetPrefixes(params.entry.name, params.channel, params.plugin)
    : "";
  const handle = params.entry.handle
    ? stripTargetPrefixes(params.entry.handle, params.channel, params.plugin)
    : "";
  const candidates = [id, name, handle].map(normalizeLowercaseStringOrEmpty).filter(Boolean);
  return candidates.some((value) =>
    params.exactOnly ? value === query : value === query || value.includes(query),
  );
}

function resolveMatch(params: {
  channel: ChannelId;
  entries: ChannelDirectoryEntry[];
  query: string;
  plugin?: ChannelPlugin;
  exactOnly?: boolean;
}) {
  const matches = params.entries.filter((entry) =>
    matchesDirectoryEntry({
      channel: params.channel,
      entry,
      query: params.query,
      plugin: params.plugin,
      exactOnly: params.exactOnly,
    }),
  );
  if (matches.length === 0) {
    return { kind: "none" as const };
  }
  if (matches.length === 1) {
    return { kind: "single" as const, entry: matches[0] };
  }
  return { kind: "ambiguous" as const, entries: matches };
}

async function listDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  query?: string;
  source: "cache" | "live";
  plugin?: ChannelPlugin;
}): Promise<ChannelDirectoryEntry[]> {
  const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
  const directory = plugin?.directory;
  if (!directory) {
    return [];
  }
  const runtime = params.runtime ?? defaultRuntime;
  const useLive = params.source === "live";
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
    source: "cache",
    signature,
    query: cacheQuery,
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  const entries = await listDirectoryEntries({
    ...params,
    source: "cache",
  });
  if (entries.length > 0 || !params.preferLiveOnMiss) {
    directoryCache.set(cacheKey, entries, params.cfg);
    return entries;
  }
  // Empty cached directory results may be stale; live lookup gets one chance
  // before both live and cache keys are updated.
  const liveKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "live",
    signature,
    query: cacheQuery,
  });
  const liveEntries = await listDirectoryEntries({
    ...params,
    source: "live",
  });
  directoryCache.set(liveKey, liveEntries, params.cfg);
  directoryCache.set(cacheKey, liveEntries, params.cfg);
  return liveEntries;
}

/** Resolves a user target through id-like, directory, plugin, and normalized fallback paths. */
export async function resolveChannelTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
  unknownTargetMode?: "error" | "normalized";
  allowNativeChannelNamespace?: boolean;
  nativeTargetMode?: ChannelOutboundTargetMode;
  allowFrom?: string[];
  plugin?: ChannelPlugin;
}): Promise<ResolveMessagingTargetResult> {
  const raw = normalizeChannelTargetInput(params.input);
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
  const channelNamespace = resolveBareTargetChannelNamespace({ raw, plugin });
  const kind = detectTargetKind(params.channel, raw, params.preferredKind, plugin);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw, plugin);
  const normalized = normalizedInput?.normalized ?? raw;
  const reservedLiteral = resolveReservedTargetLiteral({ raw, plugin });
  const targetLooksLikeId = Boolean(
    normalizedInput &&
    looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized,
      plugin,
    }),
  );
  // Explicit or contextual channel provenance may admit a plugin-native destination
  // that shares the channel name. Inferred channel selection disables this path.
  const pluginAcceptsNamespaceAsNativeTarget = Boolean(
    channelNamespace &&
    params.allowNativeChannelNamespace !== false &&
    plugin?.messaging?.normalizeTarget &&
    targetLooksLikeId,
  );
  if (
    normalizedInput &&
    !reservedLiteral &&
    (!channelNamespace ||
      (pluginAcceptsNamespaceAsNativeTarget && params.nativeTargetMode !== "heartbeat")) &&
    targetLooksLikeId
  ) {
    const resolvedIdLikeTarget = await maybeResolveIdLikeTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      accountId: params.accountId,
      preferredKind: params.preferredKind,
      plugin,
    });
    if (resolvedIdLikeTarget) {
      const outboundResolver = plugin?.outbound?.resolveTarget;
      const resolvedNativeTarget =
        channelNamespace && params.nativeTargetMode && outboundResolver
          ? resolvePluginOutboundTarget({
              cfg: params.cfg,
              resolveTarget: outboundResolver,
              input: resolvedIdLikeTarget.to,
              allowFrom: params.allowFrom,
              accountId: params.accountId,
              mode: params.nativeTargetMode,
            })
          : undefined;
      if (resolvedNativeTarget && !resolvedNativeTarget.ok) {
        return resolvedNativeTarget;
      }
      const targetTo = resolvedNativeTarget?.to.trim() ?? resolvedIdLikeTarget.to;
      if (!targetTo) {
        return { ok: false, error: missingTargetError(providerLabel, hint) };
      }
      return {
        ok: true,
        target: {
          ...resolvedIdLikeTarget,
          to: targetTo,
          kind: classifyPolicyRewrittenTarget({
            channel: params.channel,
            originalTo: resolvedIdLikeTarget.to,
            originalKind: resolvedIdLikeTarget.kind,
            resolvedTo: targetTo,
            plugin,
          }),
        },
      };
    }
    if (channelNamespace && plugin?.messaging?.targetResolver?.resolveTarget) {
      return {
        ok: false,
        error: missingChannelDestinationError(
          providerLabel,
          channelNamespace.namespace,
          channelNamespace.destinationPrefix,
          hint,
        ),
      };
    }
    return buildNormalizedResolveResult({
      normalized,
      kind,
    });
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
  const match = resolveMatch({
    channel: params.channel,
    entries,
    query,
    plugin,
    exactOnly: Boolean(reservedLiteral || channelNamespace),
  });
  if (match.kind === "single") {
    const entry = match.entry;
    if (!entry) {
      throw new Error("Single directory match is missing its entry");
    }
    const directoryTarget = normalizeDirectoryEntryId(params.channel, entry, plugin);
    const outboundResolver = plugin?.outbound?.resolveTarget;
    const resolvedDirectoryTarget =
      channelNamespace && params.nativeTargetMode && outboundResolver
        ? resolvePluginOutboundTarget({
            cfg: params.cfg,
            resolveTarget: outboundResolver,
            input: directoryTarget,
            allowFrom: params.allowFrom,
            accountId: params.accountId,
            mode: params.nativeTargetMode,
          })
        : undefined;
    if (resolvedDirectoryTarget && !resolvedDirectoryTarget.ok) {
      return resolvedDirectoryTarget;
    }
    const targetTo = resolvedDirectoryTarget?.to.trim() ?? directoryTarget;
    if (!targetTo) {
      return { ok: false, error: missingTargetError(providerLabel, hint) };
    }
    const targetKind = classifyPolicyRewrittenTarget({
      channel: params.channel,
      originalTo: directoryTarget,
      originalKind: entry.kind,
      resolvedTo: targetTo,
      plugin,
    });
    return {
      ok: true,
      target: {
        to: targetTo,
        kind: targetKind,
        display:
          entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id, params.channel, plugin),
        source: "directory",
        resolutionSource: "directory",
      },
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: ambiguousTargetError(providerLabel, raw, hint),
      candidates: match.entries,
    };
  }
  if (channelNamespace) {
    if (pluginAcceptsNamespaceAsNativeTarget && normalizedInput) {
      const resolvedNativeTarget = await maybeResolveIdLikeTarget({
        cfg: params.cfg,
        channel: params.channel,
        input: raw,
        accountId: params.accountId,
        preferredKind: params.preferredKind,
        plugin,
      });
      if (resolvedNativeTarget) {
        const outboundResolver = plugin?.outbound?.resolveTarget;
        const resolvedPolicyTarget =
          params.nativeTargetMode && outboundResolver
            ? resolvePluginOutboundTarget({
                cfg: params.cfg,
                resolveTarget: outboundResolver,
                input: resolvedNativeTarget.to,
                allowFrom: params.allowFrom,
                accountId: params.accountId,
                mode: params.nativeTargetMode,
              })
            : undefined;
        if (resolvedPolicyTarget && !resolvedPolicyTarget.ok) {
          return resolvedPolicyTarget;
        }
        const targetTo = resolvedPolicyTarget?.to.trim() ?? resolvedNativeTarget.to;
        if (!targetTo) {
          return { ok: false, error: missingTargetError(providerLabel, hint) };
        }
        return {
          ok: true,
          target: {
            ...resolvedNativeTarget,
            to: targetTo,
            kind: classifyPolicyRewrittenTarget({
              channel: params.channel,
              originalTo: resolvedNativeTarget.to,
              originalKind: resolvedNativeTarget.kind,
              resolvedTo: targetTo,
              plugin,
            }),
          },
        };
      }
    }
    const hasConcreteMessagingResolver = Boolean(plugin?.messaging?.targetResolver?.resolveTarget);
    if (
      params.allowNativeChannelNamespace !== false &&
      !hasConcreteMessagingResolver &&
      plugin?.outbound?.resolveTarget
    ) {
      const resolvedOutboundTarget = resolvePluginOutboundTarget({
        cfg: params.cfg,
        resolveTarget: plugin.outbound.resolveTarget,
        input: raw,
        allowFrom: params.allowFrom,
        accountId: params.accountId,
        mode: params.nativeTargetMode ?? "explicit",
      });
      if (!resolvedOutboundTarget.ok) {
        return resolvedOutboundTarget;
      }
      const outboundTarget = resolvedOutboundTarget.to.trim();
      if (outboundTarget) {
        return buildNormalizedResolveResult({
          normalized: outboundTarget,
          kind: detectTargetKind(params.channel, outboundTarget, undefined, plugin),
        });
      }
    }
    if (pluginAcceptsNamespaceAsNativeTarget && !hasConcreteMessagingResolver) {
      return buildNormalizedResolveResult({ normalized, kind });
    }
    return {
      ok: false,
      error: missingChannelDestinationError(
        providerLabel,
        channelNamespace.namespace,
        channelNamespace.destinationPrefix,
        hint,
      ),
    };
  }
  // Directory misses are the fail-closed boundary for reserved literals.
  if (reservedLiteral) {
    return { ok: false, error: reservedTargetLiteralError(providerLabel, reservedLiteral, hint) };
  }
  const resolvedFallbackTarget = await maybeResolvePluginMessagingTarget({
    cfg: params.cfg,
    channel: params.channel,
    input: raw,
    accountId: params.accountId,
    preferredKind: params.preferredKind,
    plugin,
  });
  if (resolvedFallbackTarget) {
    return {
      ok: true,
      target: resolvedFallbackTarget,
    };
  }

  if (params.unknownTargetMode === "normalized") {
    return buildNormalizedResolveResult({
      normalized,
      kind,
    });
  }

  return {
    ok: false,
    error: unknownTargetError(providerLabel, raw, hint),
  };
}

/** Looks up a display label for a resolved target id from cached/live directory entries. */
export async function lookupDirectoryDisplay(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;

  // Targets can resolve to either peers (DMs) or groups. Try both.
  const [groups, users] = await Promise.all([
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "group",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "user",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
  ]);

  const findMatch = (candidates: ChannelDirectoryEntry[]) =>
    candidates.find(
      (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
    );

  const entry = findMatch(groups) ?? findMatch(users);
  return entry?.name ?? entry?.handle ?? undefined;
}
