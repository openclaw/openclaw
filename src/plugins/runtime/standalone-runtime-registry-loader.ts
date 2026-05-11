import {
  type ActiveRuntimePluginRegistrySurface,
  getLoadedRuntimePluginRegistry,
} from "../active-runtime-registry.js";
import {
  loadOpenClawPlugins,
  resolvePluginRegistryLoadCacheKey,
  type PluginLoadOptions,
} from "../loader.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../runtime.js";

function resolveRuntimeSubagentMode(
  loadOptions: PluginLoadOptions,
): "default" | "explicit" | "gateway-bindable" {
  if (loadOptions.runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  if (loadOptions.runtimeOptions?.subagent) {
    return "explicit";
  }
  return "default";
}

function installStandaloneRegistry(
  registry: PluginRegistry,
  params: {
    loadOptions: PluginLoadOptions;
    surface: ActiveRuntimePluginRegistrySurface;
  },
): void {
  const cacheKey = resolvePluginRegistryLoadCacheKey(params.loadOptions);
  const mode = resolveRuntimeSubagentMode(params.loadOptions);
  setActivePluginRegistry(registry, cacheKey, mode, params.loadOptions.workspaceDir);
  switch (params.surface) {
    case "active":
      break;
    case "channel":
      pinActivePluginChannelRegistry(registry);
      break;
    case "http-route":
      pinActivePluginHttpRouteRegistry(registry);
      break;
  }
}

export function ensureStandaloneRuntimePluginRegistryLoaded(params: {
  loadOptions: PluginLoadOptions;
  forceLoad?: boolean;
  installRegistry?: boolean;
  requiredPluginIds?: readonly string[];
  surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined {
  const requiredPluginIds = params.requiredPluginIds ?? params.loadOptions.onlyPluginIds;
  const surface = params.surface ?? "active";
  if (!params.forceLoad) {
    const existing = getLoadedRuntimePluginRegistry({
      env: params.loadOptions.env,
      loadOptions: params.loadOptions,
      workspaceDir: params.loadOptions.workspaceDir,
      requiredPluginIds,
      surface,
    });
    if (existing) {
      return existing;
    }
    // Strict-cache-key miss path. The strict check above goes through
    // `resolveCompatibleRuntimePluginRegistry`, which requires the load-options
    // hash to match the active registry's cache key. Dispatch callers
    // (`ensureRuntimePluginsLoaded`) build a 3-field load-options object while
    // gateway-startup builds a 9+ field one, so the hashes never match even
    // though both name the same workspace and require the same plugin ids.
    // Re-check `getLoadedRuntimePluginRegistry` without `loadOptions` to take
    // the workspace + plugin-id branch on the active surface registry. This
    // preserves laziness (still loads when active registry is missing or
    // workspace-incompatible) but avoids a full `loadOpenClawPlugins` reload
    // on the first inbound dispatch.
    const compatible = getLoadedRuntimePluginRegistry({
      env: params.loadOptions.env,
      workspaceDir: params.loadOptions.workspaceDir,
      requiredPluginIds,
      surface,
    });
    if (compatible) {
      return compatible;
    }
  }

  const effectiveLoadOptions = params.forceLoad
    ? { ...params.loadOptions, cache: false }
    : params.loadOptions;
  const registry = loadOpenClawPlugins(effectiveLoadOptions);
  if (params.loadOptions.activate !== false) {
    switch (surface) {
      case "active":
        break;
      case "channel":
        pinActivePluginChannelRegistry(registry);
        break;
      case "http-route":
        pinActivePluginHttpRouteRegistry(registry);
        break;
    }
    return registry;
  }

  if (params.installRegistry === false) {
    return registry;
  }

  installStandaloneRegistry(registry, {
    loadOptions: params.loadOptions,
    surface,
  });
  return registry;
}
