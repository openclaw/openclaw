// Standalone runtime registry loader builds plugin runtime registries outside gateway startup.
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
  getActivePluginRegistry,
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
  // Tool-discovery loads use a tool-only plugin scope (with activate:false), so the resulting
  // registry omits provider-only plugins. Once an active registry already exists, such a load must
  // not replace it (that would wipe the live providers, e.g. the gateway agents.list list) — it is
  // only pinned to its requested channel/http-route surface. When no active registry exists yet,
  // promote it so the first standalone load still initializes runtime state (cache key /
  // workspaceDir) that later surface lookups depend on.
  if (params.loadOptions.toolDiscovery !== true || getActivePluginRegistry() === null) {
    const cacheKey = resolvePluginRegistryLoadCacheKey(params.loadOptions);
    const mode = resolveRuntimeSubagentMode(params.loadOptions);
    setActivePluginRegistry(registry, cacheKey, mode, params.loadOptions.workspaceDir);
  }
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
