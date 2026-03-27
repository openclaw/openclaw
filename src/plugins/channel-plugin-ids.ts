import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

type ModelListLike = string | { primary?: string; fallbacks?: string[] } | undefined;

function addResolvedActivationId(params: {
  raw: string | undefined;
  activationIds: Set<string>;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
}): void {
  const raw = params.raw?.trim();
  if (!raw) {
    return;
  }
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return;
  }
  params.activationIds.add(normalizeProviderId(resolved.ref.provider));
}

function addModelListActivationIds(params: {
  value: ModelListLike;
  activationIds: Set<string>;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
}): void {
  addResolvedActivationId({
    raw: resolveAgentModelPrimaryValue(params.value),
    activationIds: params.activationIds,
    aliasIndex: params.aliasIndex,
  });
  for (const fallback of resolveAgentModelFallbackValues(params.value)) {
    addResolvedActivationId({
      raw: fallback,
      activationIds: params.activationIds,
      aliasIndex: params.aliasIndex,
    });
  }
}

function addProviderModelPairActivationId(params: {
  provider: string | undefined;
  model: string | undefined;
  activationIds: Set<string>;
}): void {
  const provider = normalizeProviderId(params.provider ?? "");
  const model = params.model?.trim();
  if (!provider || !model) {
    return;
  }
  params.activationIds.add(provider);
}

function collectConfiguredActivationIds(config: OpenClawConfig): Set<string> {
  const activationIds = new Set<string>();
  const aliasIndex = buildModelAliasIndex({
    cfg: config,
    defaultProvider: DEFAULT_PROVIDER,
  });

  addModelListActivationIds({ value: config.agents?.defaults?.model, activationIds, aliasIndex });
  addModelListActivationIds({
    value: config.agents?.defaults?.imageModel,
    activationIds,
    aliasIndex,
  });
  addModelListActivationIds({
    value: config.agents?.defaults?.imageGenerationModel,
    activationIds,
    aliasIndex,
  });
  addModelListActivationIds({
    value: config.agents?.defaults?.pdfModel,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.agents?.defaults?.compaction?.model,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.agents?.defaults?.heartbeat?.model,
    activationIds,
    aliasIndex,
  });
  addModelListActivationIds({
    value: config.agents?.defaults?.subagents?.model,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.messages?.tts?.summaryModel,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.hooks?.gmail?.model,
    activationIds,
    aliasIndex,
  });

  for (const modelRef of Object.keys(config.agents?.defaults?.models ?? {})) {
    addResolvedActivationId({
      raw: modelRef,
      activationIds,
      aliasIndex,
    });
  }

  for (const providerId of Object.keys(config.agents?.defaults?.cliBackends ?? {})) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      activationIds.add(normalized);
    }
  }

  for (const providerId of Object.keys(config.models?.providers ?? {})) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      activationIds.add(normalized);
    }
  }

  for (const agent of config.agents?.list ?? []) {
    addModelListActivationIds({ value: agent.model, activationIds, aliasIndex });
    addModelListActivationIds({ value: agent.subagents?.model, activationIds, aliasIndex });
    addResolvedActivationId({
      raw: agent.heartbeat?.model,
      activationIds,
      aliasIndex,
    });
  }

  for (const mapping of config.hooks?.mappings ?? []) {
    addResolvedActivationId({
      raw: mapping.model,
      activationIds,
      aliasIndex,
    });
  }

  for (const channelMap of Object.values(config.channels?.modelByChannel ?? {})) {
    if (!channelMap || typeof channelMap !== "object") {
      continue;
    }
    for (const raw of Object.values(channelMap)) {
      addResolvedActivationId({
        raw: typeof raw === "string" ? raw : undefined,
        activationIds,
        aliasIndex,
      });
    }
  }

  addResolvedActivationId({
    raw: config.tools?.subagents?.model
      ? resolveAgentModelPrimaryValue(config.tools?.subagents?.model)
      : undefined,
    activationIds,
    aliasIndex,
  });
  if (config.tools?.subagents?.model) {
    for (const fallback of resolveAgentModelFallbackValues(config.tools.subagents.model)) {
      addResolvedActivationId({ raw: fallback, activationIds, aliasIndex });
    }
  }

  addResolvedActivationId({
    raw: config.tools?.web?.search?.gemini?.model,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.tools?.web?.search?.grok?.model,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.tools?.web?.search?.kimi?.model,
    activationIds,
    aliasIndex,
  });
  addResolvedActivationId({
    raw: config.tools?.web?.search?.perplexity?.model,
    activationIds,
    aliasIndex,
  });

  for (const entry of config.tools?.media?.models ?? []) {
    addProviderModelPairActivationId({
      provider: entry.provider,
      model: entry.model,
      activationIds,
    });
  }
  for (const entry of config.tools?.media?.image?.models ?? []) {
    addProviderModelPairActivationId({
      provider: entry.provider,
      model: entry.model,
      activationIds,
    });
  }
  for (const entry of config.tools?.media?.audio?.models ?? []) {
    addProviderModelPairActivationId({
      provider: entry.provider,
      model: entry.model,
      activationIds,
    });
  }
  for (const entry of config.tools?.media?.video?.models ?? []) {
    addProviderModelPairActivationId({
      provider: entry.provider,
      model: entry.model,
      activationIds,
    });
  }

  // Collect TTS provider
  const ttsProvider = config.messages?.tts?.provider?.trim();
  if (ttsProvider) {
    activationIds.add(ttsProvider.toLowerCase());
  }

  return activationIds;
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
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const configuredActivationIds = collectConfiguredActivationIds(params.config);

  const result = manifestRegistry.plugins
    .filter((plugin) => {
      if (plugin.channels.some((channelId) => configuredChannelIds.has(channelId))) {
        return true;
      }
      if (plugin.channels.length > 0) {
        return false;
      }
      if (
        plugin.origin === "bundled" &&
        (plugin.providers.some((providerId) =>
          configuredActivationIds.has(normalizeProviderId(providerId)),
        ) ||
          plugin.cliBackends.some((backendId) =>
            configuredActivationIds.has(normalizeProviderId(backendId)),
          ) ||
          (plugin.speechProviders ?? []).some((speechProviderId) =>
            configuredActivationIds.has(speechProviderId.toLowerCase()),
          ))
      ) {
        return true;
      }
      const enabled = resolveEffectiveEnableState({
        id: plugin.id,
        origin: plugin.origin,
        config: pluginsConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
      }).enabled;
      if (!enabled) {
        return false;
      }
      if (plugin.origin !== "bundled") {
        return true;
      }
      return (
        pluginsConfig.allow.includes(plugin.id) ||
        pluginsConfig.entries[plugin.id]?.enabled === true ||
        pluginsConfig.slots.memory === plugin.id
      );
    })
    .map((plugin) => plugin.id);

  return result;
}
