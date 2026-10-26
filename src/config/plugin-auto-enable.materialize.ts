// Applies existing activation policy to already prepared candidates.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { findUninspectedPluginDiagnostic } from "../plugins/discovery-availability.js";
import { hasExplicitManifestOwnerTrust } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";
import { isOfficialExternalPluginId } from "../plugins/official-external-plugin-catalog.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheJsonFile,
} from "../plugins/plugin-cache-files.js";
import {
  parseExternalPluginCatalogEntries,
  resolveExternalPluginCatalogPaths,
} from "../plugins/plugin-catalog-source.js";
import { resolveUserPath } from "../utils.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import { copyConfigResolutionFactsThroughRewrite } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Maximum bytes to read from an external catalog file before rejecting it. */
const MAX_EXTERNAL_CATALOG_BYTES = 16 * 1024 * 1024;
const log = createSubsystemLogger("config/plugin-catalog");

function resolveExternalCatalogPreferOver(channelId: string, env: NodeJS.ProcessEnv): string[] {
  for (const rawPath of resolveExternalPluginCatalogPaths({ env })) {
    const resolved = resolveUserPath(rawPath, env);
    if (!pluginCacheExistsSync(resolved)) {
      continue;
    }
    try {
      // Resolve symlinks so a catalog file that points to a regular file
      // keeps working while the bounded regular-file read still rejects
      // directories, FIFOs, and oversized targets.
      const resolvedRealPath = pluginCacheRealpathSync(resolved);
      if (!resolvedRealPath) {
        continue;
      }
      const payload = readPluginCacheJsonFile(resolvedRealPath, {
        maxBytes: MAX_EXTERNAL_CATALOG_BYTES,
      });
      if (!payload.ok) {
        throw payload.error;
      }
      for (const entry of parseExternalPluginCatalogEntries(payload.value)) {
        const channel = isRecord(entry.openclaw) ? entry.openclaw.channel : undefined;
        if (!isRecord(channel) || normalizeOptionalString(channel.id) !== channelId) {
          continue;
        }
        return Array.isArray(channel.preferOver)
          ? channel.preferOver.filter((value): value is string => typeof value === "string")
          : [];
      }
    } catch (err) {
      // Surface oversized catalogs so operators know a configured file was
      // skipped — unlike parse or permission errors which mean the file is
      // genuinely unusable.
      if (err instanceof Error && err.message.startsWith("File exceeds")) {
        log.warn(
          `skipping oversized external catalog file (max ${MAX_EXTERNAL_CATALOG_BYTES} bytes): ${resolved}`,
        );
      }
    }
  }
  return [];
}

function resolvePluginAutoEnableCandidateReason(candidate: PluginAutoEnableCandidate): string {
  switch (candidate.kind) {
    case "channel-configured":
      return `${candidate.channelId} configured`;
    case "provider-auth-configured":
      return `${candidate.providerId} auth configured`;
    case "provider-model-configured":
      return `${candidate.modelRef} model configured`;
    case "speech-provider-selected":
      return `${candidate.providerId} speech provider selected`;
    case "worker-provider-selected":
      return `${candidate.providerId} worker provider selected`;
    case "storage-provider-selected":
      return `${candidate.providerId} storage provider selected`;
    case "decision-provider-selected":
      return `${candidate.providerId} decision provider selected`;
    case "agent-harness-runtime-configured":
      return `${candidate.runtime} agent runtime configured`;
    case "web-search-provider-selected":
      return `${candidate.providerId} web search provider selected`;
    case "web-fetch-provider-selected":
      return `${candidate.providerId} web fetch provider selected`;
    case "plugin-web-search-configured":
      return `${candidate.pluginId} web search configured`;
    case "plugin-web-fetch-configured":
      return `${candidate.pluginId} web fetch configured`;
    case "plugin-tool-configured":
      return `${candidate.pluginId} tool configured`;
    case "configured-plugin-repaired":
      return `${candidate.pluginId} installed for existing configuration`;
    case "setup-auto-enable":
      return candidate.reason;
  }
  throw new Error("Unsupported plugin auto-enable candidate");
}

function isPluginExplicitlyDisabled(
  cfg: OpenClawConfig,
  pluginId: string,
  manifestRegistry: PluginManifestRegistry,
): boolean {
  const plugin = manifestRegistry.plugins.find((record) => record.id === pluginId);
  const builtInChannelId = plugin?.channels.length === 0 ? null : normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels;
    if (asOptionalRecord(channels?.[builtInChannelId])?.enabled === false) {
      return true;
    }
  }
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function isPluginExplicitlySelected(cfg: OpenClawConfig, pluginId: string): boolean {
  const allow = cfg.plugins?.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    return true;
  }
  return hasMaterialPluginEntryConfig(cfg.plugins?.entries?.[pluginId]);
}

function disableImplicitPreferredOverPlugin(params: {
  config: OpenClawConfig;
  originalConfig: OpenClawConfig;
  pluginId: string;
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  if (isPluginExplicitlySelected(params.originalConfig, params.pluginId)) {
    return params.config;
  }
  // A built-in channel id can remain in the static channel catalog after its
  // bundled plugin has been externalized. Do not synthesize a disabled entry
  // for that owner unless it is still present in the runtime manifest set.
  // Otherwise registry alias normalization can fold the stale channel id back
  // onto the external owner and override its explicit enabled entry.
  if (!params.manifestRegistry.plugins.some((plugin) => plugin.id === params.pluginId)) {
    return params.config;
  }
  const existingEntry = params.config.plugins?.entries?.[params.pluginId];
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      entries: {
        ...params.config.plugins?.entries,
        [params.pluginId]: {
          ...asOptionalObjectRecord(existingEntry),
          enabled: false,
        },
      },
    },
  };
}

function registerPluginEntry(
  cfg: OpenClawConfig,
  entry: PluginAutoEnableCandidate,
  builtInChannelId: string | null,
): OpenClawConfig {
  if (builtInChannelId) {
    const channels = cfg.channels;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...asOptionalRecord(channels?.[builtInChannelId]),
          enabled: true,
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [entry.pluginId]: {
          ...cfg.plugins?.entries?.[entry.pluginId],
          enabled: true,
        },
      },
    },
  };
}

export function hasMaterialPluginEntryConfig(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return (
    entry.enabled === true ||
    isRecord(entry.config) ||
    isRecord(entry.hooks) ||
    isRecord(entry.subagent) ||
    isRecord(entry.llm) ||
    entry.apiKey !== undefined ||
    entry.env !== undefined
  );
}

function isKnownPluginId(pluginId: string, manifestRegistry: PluginManifestRegistry): boolean {
  if (manifestRegistry.plugins.some((plugin) => plugin.id === pluginId)) {
    return true;
  }
  return isOfficialExternalPluginId(pluginId) || normalizeChatChannelId(pluginId) !== null;
}

export function materializePluginAutoEnableCandidatesInternal(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): PluginAutoEnableResult {
  let next = params.config ?? {};
  const changes: string[] = [];
  const autoEnabledReasons: Record<string, string[]> = Object.create(null);

  if (
    next.plugins?.enabled === false ||
    findUninspectedPluginDiagnostic(params.manifestRegistry.diagnostics)
  ) {
    return { config: next, changes, autoEnabledReasons: {} };
  }

  const preferOverCache = new Map<string, string[]>();
  const workspacePluginIds = new Set(
    params.manifestRegistry.plugins
      .filter((plugin) => plugin.origin === "workspace")
      .map((plugin) => plugin.id),
  );
  const normalizedConfig = normalizePluginsConfig(next.plugins);
  const preferenceCandidates = params.candidates.filter((entry) => {
    if (!workspacePluginIds.has(entry.pluginId)) {
      return true;
    }
    return hasExplicitManifestOwnerTrust({
      plugin: { id: entry.pluginId },
      normalizedConfig,
    });
  });
  const candidates = preferenceCandidates.filter(
    (entry) => !workspacePluginIds.has(entry.pluginId),
  );

  for (const entry of candidates) {
    const builtInChannelId = ((): string | null => {
      const manifestRegistry = params.manifestRegistry;
      if (entry.kind === "configured-plugin-repaired") {
        return null;
      }
      const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
      // An admitted manifest already establishes that a provider/tool owns no channels.
      if (plugin?.channels.length === 0) {
        return null;
      }
      const channelId =
        entry.kind === "channel-configured"
          ? (normalizeChatChannelId(entry.channelId) ?? entry.channelId)
          : null;
      const claimsChannel =
        channelId !== null &&
        (plugin?.channels ?? []).some((id) => (normalizeChatChannelId(id) ?? id) === channelId);
      if (plugin && plugin.origin !== "bundled" && (channelId === null || claimsChannel)) {
        return null;
      }
      return (
        normalizeChatChannelId(entry.pluginId) ??
        (plugin?.origin === "bundled" && claimsChannel ? channelId : null)
      );
    })();
    if (
      isPluginDenied(next, entry.pluginId) ||
      isPluginExplicitlyDisabled(next, entry.pluginId, params.manifestRegistry)
    ) {
      continue;
    }
    const env = params.env;
    const preferenceRegistry = params.manifestRegistry;
    const getPreferredOverIds = (candidate: PluginAutoEnableCandidate): string[] => {
      const cacheKey = `${candidate.pluginId}:${candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId}`;
      const cached = preferOverCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const resolved = ((): string[] => {
        const channelId =
          candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
        const installedPlugin = preferenceRegistry.plugins.find(
          (record) => record.id === candidate.pluginId,
        );
        const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[channelId]?.preferOver;
        if (manifestChannelPreferOver?.length) {
          return [...manifestChannelPreferOver];
        }
        const installedChannelMeta = installedPlugin?.channelCatalogMeta;
        if (installedChannelMeta?.preferOver?.length) {
          return [...installedChannelMeta.preferOver];
        }
        if (installedPlugin?.channels.length === 0) {
          return [];
        }
        const preferredChannelId = normalizeChatChannelId(channelId);
        const builtInChannelPreferOver = preferredChannelId
          ? findChatChannelMeta(preferredChannelId)?.preferOver
          : undefined;
        if (builtInChannelPreferOver?.length) {
          return [...builtInChannelPreferOver];
        }
        return resolveExternalCatalogPreferOver(channelId, env);
      })();
      preferOverCache.set(cacheKey, resolved);
      return resolved;
    };
    if (
      preferenceCandidates.some(
        (other) =>
          other.pluginId !== entry.pluginId &&
          !isPluginDenied(next, other.pluginId) &&
          !isPluginExplicitlyDisabled(next, other.pluginId, params.manifestRegistry) &&
          getPreferredOverIds(other).includes(entry.pluginId),
      )
    ) {
      next = disableImplicitPreferredOverPlugin({
        config: next,
        originalConfig: params.config ?? {},
        pluginId: entry.pluginId,
        manifestRegistry: params.manifestRegistry,
      });
      continue;
    }

    const allow = next.plugins?.allow;
    const hasRestrictiveAllowlist = Array.isArray(allow) && allow.length > 0;
    const allowMissing = hasRestrictiveAllowlist && !allow.includes(entry.pluginId);
    const alreadyEnabled =
      builtInChannelId != null
        ? asOptionalRecord(next.channels?.[builtInChannelId])?.enabled === true
        : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }

    next = registerPluginEntry(next, entry, builtInChannelId);
    if (hasRestrictiveAllowlist) {
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    const reason = resolvePluginAutoEnableCandidateReason(entry);
    if (!isBlockedObjectKey(entry.pluginId)) {
      (autoEnabledReasons[entry.pluginId] ??= []).push(reason);
    }
    const manifestRegistry = params.manifestRegistry;
    let change: string | undefined;
    if (entry.kind === "channel-configured") {
      const configuredChannelId = normalizeChatChannelId(entry.channelId);
      const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
      const label =
        (configuredChannelId ? findChatChannelMeta(configuredChannelId)?.label : undefined) ??
        plugin?.channelConfigs?.[entry.channelId]?.label ??
        plugin?.channelCatalogMeta?.label;
      if (label) {
        change = `${label} configured, enabled automatically.`;
      }
    }
    changes.push(
      change ?? `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`,
    );
  }

  {
    let configured = next;
    const manifestRegistry = params.manifestRegistry;
    const allow = configured.plugins?.allow;
    const entries = asOptionalObjectRecord(configured.plugins?.entries);
    if (Array.isArray(allow) && allow.length > 0 && entries) {
      for (const pluginId of Object.keys(entries).toSorted((left, right) =>
        left.localeCompare(right),
      )) {
        const entry = entries[pluginId];
        if (
          isNativeSessionCatalogOptOutOnly(pluginId, entry) ||
          !hasMaterialPluginEntryConfig(entry) ||
          isPluginDenied(configured, pluginId) ||
          isPluginExplicitlyDisabled(configured, pluginId, manifestRegistry) ||
          allow.includes(pluginId) ||
          !isKnownPluginId(pluginId, manifestRegistry)
        ) {
          continue;
        }
        configured = ensurePluginAllowlisted(configured, pluginId);
        changes.push(`${pluginId} plugin config present, added to plugin allowlist.`);
      }
    }

    next = configured;
  }

  if (next !== params.config) {
    // Auto-enable rebuilds the touched config sections, so the result reaches callers
    // without the loader's unresolved-reference facts. Credential consumers (for example
    // A2A peer tokens on the message CLI path) read those facts to tell an unset `${VAR}`
    // from literal text, so carry them over for every path the rewrite left untouched.
    copyConfigResolutionFactsThroughRewrite(params.config, next);
  }

  return { config: next, changes, autoEnabledReasons };
}
