// Applies existing activation policy to already prepared candidates.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizePluginId, normalizePluginsConfig } from "../plugins/config-state.js";
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
import { copyConfigResolutionFactsThroughRewrite } from "./resolution-facts.js";
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
  return (
    normalizePluginsConfig(cfg.plugins).entries[normalizePluginId(pluginId)]?.enabled === false
  );
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  return normalizePluginsConfig(cfg.plugins).deny.includes(normalizePluginId(pluginId));
}

function isPluginExplicitlySelected(cfg: OpenClawConfig, pluginId: string): boolean {
  const policyId = normalizePluginId(pluginId);
  if (normalizePluginsConfig(cfg.plugins).allow.includes(policyId)) {
    return true;
  }
  // The normalized policy view omits apiKey and env; preserve raw configuration.
  return Object.entries(cfg.plugins?.entries ?? {}).some(
    ([key, entry]) => normalizePluginId(key) === policyId && hasMaterialPluginEntryConfig(entry),
  );
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
  const policyId = normalizePluginId(params.pluginId);
  const existingEntry = params.config.plugins?.entries?.[policyId];
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      entries: {
        ...params.config.plugins?.entries,
        [policyId]: {
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

  const policyId = normalizePluginId(entry.pluginId);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [policyId]: {
          ...cfg.plugins?.entries?.[policyId],
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
    // Validation materializes `{}` defaults for enabled plugins; an empty object carries
    // no operator configuration and must not widen a restrictive plugins.allow.
    (isRecord(entry.config) && Object.keys(entry.config).length > 0) ||
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
    const policyId = normalizePluginId(pluginId);
    if (
      isNativeSessionCatalogOptOutOnly(pluginId, entry) ||
      !hasMaterialPluginEntryConfig(entry) ||
      isPluginDenied(next, pluginId) ||
      isPluginExplicitlyDisabled(next, pluginId) ||
      normalizePluginsConfig(next.plugins).allow.includes(policyId) ||
      !isKnownPluginId(pluginId, params.manifestRegistry)
    ) {
      continue;
    }
    next = ensurePluginAllowlisted(next, policyId);
    params.changes.push(`${policyId} plugin config present, added to plugin allowlist.`);
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
    const policyId = normalizePluginId(entry.pluginId);
    const normalizedPlugins = normalizePluginsConfig(next.plugins);
    const allowMissing = hasRestrictiveAllowlist && !normalizedPlugins.allow.includes(policyId);
    const alreadyEnabled =
      builtInChannelId != null
        ? asOptionalRecord(next.channels?.[builtInChannelId])?.enabled === true
        : normalizedPlugins.entries[policyId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }

    next = registerPluginEntry(next, entry, builtInChannelId);
    if (allowMissing) {
      next = ensurePluginAllowlisted(next, policyId);
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

  if (next !== params.config) {
    // Auto-enable rebuilds the touched config sections, so the result reaches callers
    // without the loader's unresolved-reference facts. Credential consumers (for example
    // A2A peer tokens on the message CLI path) read those facts to tell an unset `${VAR}`
    // from literal text, so carry them over for every path the rewrite left untouched.
    copyConfigResolutionFactsThroughRewrite(params.config, next);
  }

  return { config: next, changes, autoEnabledReasons };
}
