import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { hasKind } from "./slots.js";

function normalizeSpeechProviderIdForTts(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** Bundled plugin ids that must load at gateway startup so TTS speech providers register (see issue #61412). */
export function resolveGatewayTtsSpeechPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const tts = params.config.messages?.tts;
  if (!tts) {
    return [];
  }
  const requested = new Set<string>();
  const primary = normalizeSpeechProviderIdForTts(tts.provider);
  if (primary) {
    requested.add(primary);
  }
  for (const key of Object.keys(tts.providers ?? {})) {
    const normalized = normalizeSpeechProviderIdForTts(key);
    if (normalized) {
      requested.add(normalized);
    }
  }
  if (requested.size === 0) {
    return [];
  }
  const manifest = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const owners = new Set<string>();
  for (const speechProviderId of requested) {
    const normalized = speechProviderId.trim().toLowerCase();
    const pluginId = manifest.plugins.find((plugin) =>
      (plugin.contracts?.speechProviders ?? []).some(
        (candidate) => candidate.trim().toLowerCase() === normalized,
      ),
    )?.id;
    if (pluginId) {
      owners.add(pluginId);
    }
  }
  return [...owners].toSorted((left, right) => left.localeCompare(right));
}

function hasRuntimeContractSurface(plugin: PluginManifestRecord): boolean {
  return Boolean(
    plugin.providers.length > 0 ||
    plugin.contracts?.speechProviders?.length ||
    plugin.contracts?.mediaUnderstandingProviders?.length ||
    plugin.contracts?.imageGenerationProviders?.length ||
    plugin.contracts?.videoGenerationProviders?.length ||
    plugin.contracts?.musicGenerationProviders?.length ||
    plugin.contracts?.webFetchProviders?.length ||
    plugin.contracts?.webSearchProviders?.length ||
    plugin.contracts?.memoryEmbeddingProviders?.length ||
    hasKind(plugin.kind, "memory"),
  );
}

function isGatewayStartupSidecar(plugin: PluginManifestRecord): boolean {
  return plugin.channels.length === 0 && !hasRuntimeContractSurface(plugin);
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return resolveChannelPluginIds(params).filter((pluginId) => configuredChannelIds.has(pluginId));
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.channels.some((channelId) => configuredChannelIds.has(channelId)) &&
        plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
    )
    .map((plugin) => plugin.id);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const baseIds = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => {
      if (plugin.channels.some((channelId) => configuredChannelIds.has(channelId))) {
        return true;
      }
      if (!isGatewayStartupSidecar(plugin)) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: pluginsConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
        activationSource,
      });
      if (!activationState.enabled) {
        return false;
      }
      if (plugin.origin !== "bundled") {
        return activationState.explicitlyEnabled;
      }
      return activationState.source === "explicit" || activationState.source === "default";
    })
    .map((plugin) => plugin.id);

  const ttsSpeechPluginIds = resolveGatewayTtsSpeechPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (ttsSpeechPluginIds.length === 0) {
    return baseIds;
  }
  const seen = new Set(baseIds);
  const merged = [...baseIds];
  for (const id of ttsSpeechPluginIds) {
    if (!seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
  }
  return merged;
}
