import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginHttpRouteRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
} from "./runtime.js";

export type ActiveRuntimePluginRegistrySurface = "active" | "channel" | "http-route";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

function normalizeRequiredPluginIds(ids?: readonly string[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function registryContainsPluginIds(
  registry: PluginRegistry,
  pluginIds: readonly string[] | undefined,
): boolean {
  if (pluginIds === undefined) {
    return true;
  }
  if (pluginIds.length === 0) {
    return true;
  }
  const loaded = new Set<string>();
  for (const plugin of registry.plugins ?? []) {
    if (plugin.status === undefined || plugin.status === "loaded") {
      loaded.add(plugin.id);
    }
  }
  for (const value of Object.values(registry)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (entry && typeof entry === "object" && "pluginId" in entry) {
        const pluginId = entry.pluginId;
        if (typeof pluginId === "string" && pluginId.length > 0) {
          loaded.add(pluginId);
        }
      }
    }
  }
  return pluginIds.every((pluginId) => loaded.has(pluginId));
}

function resolveSurfaceRegistry(
  surface: ActiveRuntimePluginRegistrySurface,
): PluginRegistry | null {
  switch (surface) {
    case "active":
      return getActivePluginRegistry();
    case "channel":
      return getActivePluginChannelRegistry();
    case "http-route":
      return getActivePluginHttpRouteRegistry();
  }
  return null;
}

export function getLoadedRuntimePluginRegistry(
  params: {
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    requiredPluginIds?: readonly string[];
    surface?: ActiveRuntimePluginRegistrySurface;
  } = {},
): PluginRegistry | undefined {
  void params.env;
  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  if (params.workspaceDir && activeWorkspaceDir && params.workspaceDir !== activeWorkspaceDir) {
    return undefined;
  }
  const registry = resolveSurfaceRegistry(params.surface ?? "active");
  if (!registry) {
    return undefined;
  }
  const requiredPluginIds = normalizeRequiredPluginIds(params.requiredPluginIds);
  if (!registryContainsPluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
