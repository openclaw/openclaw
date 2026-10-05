// Applies existing activation policy to already prepared candidates.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { findUninspectedPluginDiagnostic } from "../plugins/discovery-availability.js";
import { hasExplicitManifestOwnerTrust } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";
import { isOfficialExternalPluginId } from "../plugins/official-external-plugin-catalog.js";
import { shouldSkipPreferredPluginAutoEnable } from "./plugin-auto-enable.prefer-over.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import type { OpenClawConfig } from "./types.openclaw.js";

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

function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
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

function resolveAutoEnableChannelId(params: {
  entry: PluginAutoEnableCandidate;
  manifestRegistry: PluginManifestRegistry;
}): string | null {
  if (params.entry.kind === "configured-plugin-repaired") {
    return null;
  }
  const plugin = params.manifestRegistry.plugins.find(
    (record) => record.id === params.entry.pluginId,
  );
  const channelId =
    params.entry.kind === "channel-configured"
      ? (normalizeChatChannelId(params.entry.channelId) ?? params.entry.channelId)
      : null;
  const claimsChannel =
    channelId !== null &&
    (plugin?.channels ?? []).some((id) => (normalizeChatChannelId(id) ?? id) === channelId);
  if (plugin && plugin.origin !== "bundled" && (channelId === null || claimsChannel)) {
    return null;
  }
  return (
    normalizeChatChannelId(params.entry.pluginId) ??
    (plugin?.origin === "bundled" && claimsChannel ? channelId : null)
  );
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
  if (normalizeChatChannelId(pluginId)) {
    return true;
  }
  return (
    manifestRegistry.plugins.some((plugin) => plugin.id === pluginId) ||
    isOfficialExternalPluginId(pluginId)
  );
}

function materializeConfiguredPluginEntryAllowlist(params: {
  config: OpenClawConfig;
  changes: string[];
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  let next = params.config;
  const allow = next.plugins?.allow;
  const entries = asOptionalObjectRecord(next.plugins?.entries);
  if (!Array.isArray(allow) || allow.length === 0 || !entries) {
    return next;
  }

  for (const pluginId of Object.keys(entries).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const entry = entries[pluginId];
    if (
      isNativeSessionCatalogOptOutOnly(pluginId, entry) ||
      !hasMaterialPluginEntryConfig(entry) ||
      isPluginDenied(next, pluginId) ||
      isPluginExplicitlyDisabled(next, pluginId) ||
      allow.includes(pluginId) ||
      !isKnownPluginId(pluginId, params.manifestRegistry)
    ) {
      continue;
    }
    next = ensurePluginAllowlisted(next, pluginId);
    params.changes.push(`${pluginId} plugin config present, added to plugin allowlist.`);
  }

  return next;
}

function formatAutoEnableChange(
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): string {
  if (entry.kind === "channel-configured") {
    const builtInChannelId = normalizeChatChannelId(entry.channelId);
    const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
    const label =
      (builtInChannelId ? findChatChannelMeta(builtInChannelId)?.label : undefined) ??
      plugin?.channelConfigs?.[entry.channelId]?.label ??
      plugin?.channelCatalogMeta?.label;
    if (label) {
      return `${label} configured, enabled automatically.`;
    }
  }
  return `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`;
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
    const builtInChannelId = resolveAutoEnableChannelId({
      entry,
      manifestRegistry: params.manifestRegistry,
    });
    if (isPluginDenied(next, entry.pluginId) || isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (
      shouldSkipPreferredPluginAutoEnable({
        config: next,
        entry,
        configured: preferenceCandidates,
        env: params.env,
        registry: params.manifestRegistry,
        isPluginDenied,
        isPluginExplicitlyDisabled,
        preferOverCache,
      })
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
    changes.push(formatAutoEnableChange(entry, params.manifestRegistry));
  }

  next = materializeConfiguredPluginEntryAllowlist({
    config: next,
    changes,
    manifestRegistry: params.manifestRegistry,
  });

  return { config: next, changes, autoEnabledReasons };
}
