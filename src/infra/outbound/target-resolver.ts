import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
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
import {
  classifyRewrittenTarget,
  detectTargetKind,
  type TargetResolveKind,
} from "./target-kind.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
  resolveReservedTargetLiteral,
} from "./target-normalization.js";
import {
  buildNormalizedResolveResult,
  stripTargetPrefixes,
  type ResolvedMessagingTarget,
} from "./target-resolution-results.js";

export type { ResolvedMessagingTarget } from "./target-resolution-results.js";

type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | {
      ok: false;
      error: Error;
      candidates?: ChannelDirectoryEntry[];
      policyRejected?: true;
    };

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

function applyOutboundTargetPolicy(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  target: ResolvedMessagingTarget;
  mode?: ChannelOutboundTargetMode;
  allowFrom?: string[];
  accountId?: string | null;
  plugin?: ChannelPlugin;
}): ResolveMessagingTargetResult {
  const policyResult =
    params.mode && params.plugin?.outbound?.resolveTarget
      ? params.plugin.outbound.resolveTarget({
          cfg: params.cfg,
          to: params.target.to,
          allowFrom: params.allowFrom,
          accountId: params.accountId,
          mode: params.mode,
        })
      : undefined;
  if (policyResult && !policyResult.ok) {
    return { ...policyResult, policyRejected: true };
  }
  const to = (policyResult?.to ?? params.target.to).trim();
  if (!to) {
    return {
      ok: false,
      error: missingTargetError(
        params.plugin?.meta?.label ?? params.channel,
        params.plugin?.messaging?.targetResolver?.hint,
      ),
    };
  }
  return {
    ok: true,
    target: {
      ...params.target,
      to,
      kind: classifyRewrittenTarget({
        channel: params.channel,
        originalTo: params.target.to,
        originalKind: params.target.kind,
        resolvedTo: to,
        plugin: params.plugin,
      }),
    },
  };
}

function buildRewrittenNormalizedTarget(params: {
  channel: ChannelId;
  raw: string;
  normalized: string;
  kind: TargetResolveKind;
  plugin?: ChannelPlugin;
}): ResolvedMessagingTarget {
  return buildNormalizedResolveResult({
    normalized: params.normalized,
    kind: classifyRewrittenTarget({
      channel: params.channel,
      originalTo: params.raw,
      originalKind: params.kind,
      resolvedTo: params.normalized,
      plugin: params.plugin,
    }),
  }).target;
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
  const candidates = [
    normalizeDirectoryEntryId(params.channel, params.entry, params.plugin),
    params.entry.name,
    params.entry.handle,
  ]
    .map((value) => (value ? stripTargetPrefixes(value, params.channel, params.plugin) : ""))
    .map(normalizeLowercaseStringOrEmpty)
    .filter(Boolean);
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
    signature,
    query: cacheQuery,
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  let entries = await listDirectoryEntries({
    ...params,
    source: "cache",
  });
  if (entries.length === 0 && params.preferLiveOnMiss) {
    // Empty directory results get one live lookup before caching the final result.
    entries = await listDirectoryEntries({ ...params, source: "live" });
  }
  directoryCache.set(cacheKey, entries, params.cfg);
  return entries;
}

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
  let nativeNamespaceResolverMissed = false;
  if (
    normalizedInput &&
    !reservedLiteral &&
    (!channelNamespace ||
      (pluginAcceptsNamespaceAsNativeTarget && params.nativeTargetMode !== "heartbeat")) &&
    targetLooksLikeId
  ) {
    const resolvedIdLikeTarget = await maybeResolvePluginMessagingTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      accountId: params.accountId,
      preferredKind: params.preferredKind,
      plugin,
      requireIdLike: true,
    });
    if (resolvedIdLikeTarget) {
      return applyOutboundTargetPolicy({
        cfg: params.cfg,
        channel: params.channel,
        target: resolvedIdLikeTarget,
        mode: params.nativeTargetMode,
        allowFrom: params.allowFrom,
        accountId: params.accountId,
        plugin,
      });
    }
    if (channelNamespace && plugin?.messaging?.targetResolver?.resolveTarget) {
      nativeNamespaceResolverMissed = true;
    } else {
      return applyOutboundTargetPolicy({
        cfg: params.cfg,
        channel: params.channel,
        target: buildRewrittenNormalizedTarget({
          channel: params.channel,
          raw,
          normalized,
          kind,
          plugin,
        }),
        mode: params.nativeTargetMode,
        allowFrom: params.allowFrom,
        accountId: params.accountId,
        plugin,
      });
    }
  }
  const query = stripTargetPrefixes(raw, params.channel, plugin);
  const primaryDirectoryKind: ChannelDirectoryEntryKind = kind === "user" ? "user" : "group";
  // A bare channel namespace has no peer/group syntax. Search both directory
  // owners before treating it as a missing destination.
  const directoryKinds: ChannelDirectoryEntryKind[] = channelNamespace
    ? [primaryDirectoryKind, primaryDirectoryKind === "user" ? "group" : "user"]
    : [primaryDirectoryKind];
  const entries = (
    await Promise.all(
      directoryKinds.map((directoryKind) =>
        getDirectoryEntries({
          cfg: params.cfg,
          channel: params.channel,
          accountId: params.accountId,
          kind: directoryKind,
          query,
          runtime: params.runtime,
          preferLiveOnMiss: true,
          plugin,
        }),
      ),
    )
  ).flat();
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
    return applyOutboundTargetPolicy({
      cfg: params.cfg,
      channel: params.channel,
      target: {
        to: directoryTarget,
        kind: entry.kind,
        display:
          entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id, params.channel, plugin),
        source: "directory",
        resolutionSource: "directory",
      },
      mode: params.nativeTargetMode,
      allowFrom: params.allowFrom,
      accountId: params.accountId,
      plugin,
    });
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: ambiguousTargetError(providerLabel, raw, hint),
      candidates: match.entries,
    };
  }
  if (channelNamespace) {
    if (pluginAcceptsNamespaceAsNativeTarget && normalizedInput && !nativeNamespaceResolverMissed) {
      const resolvedNativeTarget = await maybeResolvePluginMessagingTarget({
        cfg: params.cfg,
        channel: params.channel,
        input: raw,
        accountId: params.accountId,
        preferredKind: params.preferredKind,
        plugin,
        requireIdLike: true,
      });
      if (resolvedNativeTarget) {
        return applyOutboundTargetPolicy({
          cfg: params.cfg,
          channel: params.channel,
          target: resolvedNativeTarget,
          mode: params.nativeTargetMode,
          allowFrom: params.allowFrom,
          accountId: params.accountId,
          plugin,
        });
      }
    }
    const hasConcreteMessagingResolver = Boolean(plugin?.messaging?.targetResolver?.resolveTarget);
    if (
      params.allowNativeChannelNamespace !== false &&
      !hasConcreteMessagingResolver &&
      plugin?.outbound?.resolveTarget
    ) {
      const resolvedOutboundTarget = plugin.outbound.resolveTarget({
        cfg: params.cfg,
        to: raw,
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
      return applyOutboundTargetPolicy({
        cfg: params.cfg,
        channel: params.channel,
        target: buildRewrittenNormalizedTarget({
          channel: params.channel,
          raw,
          normalized,
          kind,
          plugin,
        }),
        mode: params.nativeTargetMode,
        allowFrom: params.allowFrom,
        accountId: params.accountId,
        plugin,
      });
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
    return applyOutboundTargetPolicy({
      cfg: params.cfg,
      channel: params.channel,
      target: resolvedFallbackTarget,
      mode: params.nativeTargetMode,
      allowFrom: params.allowFrom,
      accountId: params.accountId,
      plugin,
    });
  }

  if (params.unknownTargetMode === "normalized") {
    return applyOutboundTargetPolicy({
      cfg: params.cfg,
      channel: params.channel,
      target: buildRewrittenNormalizedTarget({
        channel: params.channel,
        raw,
        normalized,
        kind,
        plugin,
      }),
      mode: params.nativeTargetMode,
      allowFrom: params.allowFrom,
      accountId: params.accountId,
      plugin,
    });
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
