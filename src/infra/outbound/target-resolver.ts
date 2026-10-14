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
import { classifyRewrittenTarget, detectTargetKind } from "./target-kind.js";
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
  directoryCache.clearMatching(
    (key) =>
      key.startsWith(`${channelKey}:`) &&
      (!params.accountId || key.startsWith(`${channelKey}:${accountKey}:`)),
    params.cfg,
  );
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

  if (!trimmedTarget || trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) {
    return trimmedTarget;
  }

  const channelPrefix = `${params.channel}:`;
  const withoutProvider = lowered.startsWith(channelPrefix)
    ? trimmedTarget.slice(channelPrefix.length)
    : trimmedTarget;

  return withoutProvider.replace(/^channel:/i, "#").replace(/^user:/i, "@");
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
        originalKindIsResolved:
          params.target.resolutionSource === "directory" ||
          params.target.resolutionSource === "plugin",
        resolvedTo: to,
        plugin: params.plugin,
      }),
    },
  };
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
    const method = params.kind === "user" ? "listPeers" : "listGroups";
    const fn = useLive ? (directory[`${method}Live`] ?? directory[method]) : directory[method];
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
  allowNativeChannelNamespace?: boolean;
  nativeTargetMode?: ChannelOutboundTargetMode;
  allowFrom?: string[];
  plugin?: ChannelPlugin;
}): Promise<ResolveMessagingTargetResult> {
  const raw = params.input.trim();
  const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
  const providerLabel = plugin?.meta?.label ?? params.channel;
  const hint = plugin?.messaging?.targetResolver?.hint;
  if (!raw) {
    return {
      ok: false,
      error: missingTargetError(providerLabel, hint),
    };
  }
  const channelNamespace = resolveBareTargetChannelNamespace({ raw, plugin });
  const kind = detectTargetKind(params.channel, raw, params.preferredKind, plugin);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw, plugin);
  const normalized = normalizedInput?.normalized ?? raw;
  const reservedLiteral = resolveReservedTargetLiteral({ raw, plugin });
  const applyPolicy = (target: ResolvedMessagingTarget) =>
    applyOutboundTargetPolicy({
      cfg: params.cfg,
      channel: params.channel,
      target,
      mode: params.nativeTargetMode,
      allowFrom: params.allowFrom,
      accountId: params.accountId,
      plugin,
    });
  const buildNormalizedTarget = () =>
    buildNormalizedResolveResult({
      normalized,
      kind: classifyRewrittenTarget({
        channel: params.channel,
        originalTo: raw,
        originalKind: kind,
        resolvedTo: normalized,
        plugin,
      }),
    }).target;
  const resolvePluginTarget = (requireIdLike?: boolean) =>
    maybeResolvePluginMessagingTarget({ ...params, input: raw, plugin, requireIdLike });
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
  const hasConcreteMessagingResolver = Boolean(plugin?.messaging?.targetResolver?.resolveTarget);
  const pluginAcceptsNamespaceAsNativeTarget = Boolean(
    channelNamespace &&
    params.allowNativeChannelNamespace !== false &&
    (hasConcreteMessagingResolver || targetLooksLikeId),
  );
  let nativeNamespaceResolverMissed = false;
  if (
    normalizedInput &&
    !reservedLiteral &&
    (!channelNamespace ||
      (pluginAcceptsNamespaceAsNativeTarget && params.nativeTargetMode !== "heartbeat")) &&
    targetLooksLikeId
  ) {
    const resolvedIdLikeTarget = await resolvePluginTarget(true);
    if (resolvedIdLikeTarget) {
      return applyPolicy(resolvedIdLikeTarget);
    }
    if (channelNamespace && hasConcreteMessagingResolver) {
      nativeNamespaceResolverMissed = true;
    } else {
      return applyPolicy(buildNormalizedTarget());
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
          reservedLiteral || channelNamespace
            ? value === normalizedQuery
            : value.includes(normalizedQuery),
        );
      })
    : [];
  const [entry] = matches;
  if (matches.length === 1 && entry) {
    return applyPolicy({
      to: normalizeDirectoryEntryId(params.channel, entry, plugin),
      kind: entry.kind,
      display: entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id, params.channel, plugin),
      source: "directory",
      resolutionSource: "directory",
    });
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
  if (channelNamespace) {
    if (pluginAcceptsNamespaceAsNativeTarget && normalizedInput && !nativeNamespaceResolverMissed) {
      const resolvedNativeTarget = await resolvePluginTarget();
      if (resolvedNativeTarget) {
        return applyPolicy(resolvedNativeTarget);
      }
    }
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
          kind: classifyRewrittenTarget({
            channel: params.channel,
            originalTo: raw,
            originalKind: kind,
            resolvedTo: outboundTarget,
            plugin,
          }),
        });
      }
    }
    if (pluginAcceptsNamespaceAsNativeTarget && !hasConcreteMessagingResolver) {
      return applyPolicy(buildNormalizedTarget());
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
  const resolvedFallbackTarget = await resolvePluginTarget();
  if (resolvedFallbackTarget) {
    return applyPolicy(resolvedFallbackTarget);
  }

  if (params.unknownTargetMode === "normalized") {
    return applyPolicy(buildNormalizedTarget());
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
