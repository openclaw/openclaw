import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import {
  pluginRegistrationContractRegistry,
  webSearchProviderContractRegistry,
} from "./contracts/registry.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

const log = createSubsystemLogger("plugins");

function hasExplicitPluginConfig(config: PluginLoadOptions["config"]): boolean {
  const plugins = config?.plugins;
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  return false;
}

function resolveBundledWebSearchCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  void params;
  return pluginRegistrationContractRegistry
    .filter((plugin) => plugin.webSearchProviderIds.length > 0)
    .map((plugin) => plugin.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

function withBundledWebSearchVitestCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  const env = params.env ?? process.env;
  const isVitest = Boolean(env.VITEST || process.env.VITEST);
  if (!isVitest || hasExplicitPluginConfig(params.config) || params.pluginIds.length === 0) {
    return params.config;
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      enabled: true,
      allow: [...params.pluginIds],
      slots: {
        ...params.config?.plugins?.slots,
        memory: "none",
      },
    },
  };
}

function applyVitestContractMetadataCompat(
  providers: PluginWebSearchProviderEntry[],
  env?: PluginLoadOptions["env"],
): PluginWebSearchProviderEntry[] {
  if (!(env?.VITEST || process.env.VITEST)) {
    return providers;
  }

  return providers.map((provider) => {
    const contract = webSearchProviderContractRegistry.find(
      (entry) => entry.pluginId === provider.pluginId && entry.provider.id === provider.id,
    );
    if (!contract) {
      return provider;
    }
    return {
      ...contract.provider,
      ...provider,
      credentialPath: provider.credentialPath ?? contract.provider.credentialPath,
      inactiveSecretPaths: provider.inactiveSecretPaths ?? contract.provider.inactiveSecretPaths,
      applySelectionConfig: provider.applySelectionConfig ?? contract.provider.applySelectionConfig,
      resolveRuntimeMetadata:
        provider.resolveRuntimeMetadata ?? contract.provider.resolveRuntimeMetadata,
    };
  });
}

function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((a, b) => {
    const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  activate?: boolean;
  cache?: boolean;
}): PluginWebSearchProviderEntry[] {
  const bundledCompatPluginIds = resolveBundledWebSearchCompatPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: bundledCompatPluginIds,
      })
    : params.config;
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: bundledCompatPluginIds,
  });
  const config = withBundledWebSearchVitestCompat({
    config: enablementCompat,
    pluginIds: bundledCompatPluginIds,
    env: params.env,
  });
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    logger: createPluginLoaderLogger(log),
  });

  return sortWebSearchProviders(
    applyVitestContractMetadataCompat(
      registry.webSearchProviders.map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
      params.env,
    ),
  );
}

export function resolveRuntimeWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): PluginWebSearchProviderEntry[] {
  const runtimeProviders = getActivePluginRegistry()?.webSearchProviders ?? [];
  if (runtimeProviders.length > 0) {
    return sortWebSearchProviders(
      runtimeProviders.map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
    );
  }
  return resolvePluginWebSearchProviders(params);
}
