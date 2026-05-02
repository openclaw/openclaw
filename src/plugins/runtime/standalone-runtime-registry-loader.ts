import {
  type ActiveRuntimePluginRegistrySurface,
  getLoadedRuntimePluginRegistry,
} from "../active-runtime-registry.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "../loader.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../runtime.js";

export function ensureStandaloneRuntimePluginRegistryLoaded(params: {
  loadOptions: PluginLoadOptions;
  requiredPluginIds?: readonly string[];
  surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined {
  const requiredPluginIds = params.requiredPluginIds ?? params.loadOptions.onlyPluginIds;
  const surface = params.surface ?? "active";
  if (requiredPluginIds !== undefined && requiredPluginIds.length === 0) {
    return getLoadedRuntimePluginRegistry({
      env: params.loadOptions.env,
      workspaceDir: params.loadOptions.workspaceDir,
      requiredPluginIds,
      surface,
    });
  }
  const existing = getLoadedRuntimePluginRegistry({
    env: params.loadOptions.env,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds,
    surface,
  });
  if (existing) {
    return existing;
  }

  const registry = loadOpenClawPlugins(params.loadOptions);
  switch (surface) {
    case "active":
      setActivePluginRegistry(registry, undefined, "default", params.loadOptions.workspaceDir);
      break;
    case "channel":
      setActivePluginRegistry(registry, undefined, "default", params.loadOptions.workspaceDir);
      pinActivePluginChannelRegistry(registry);
      break;
    case "http-route":
      setActivePluginRegistry(registry, undefined, "default", params.loadOptions.workspaceDir);
      pinActivePluginHttpRouteRegistry(registry);
      break;
  }
  return registry;
}
