import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveCompatibleRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginHttpRouteRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
} from "./runtime.js";

export type ActiveRuntimePluginRegistrySurface = "active" | "channel" | "http-route";

/** Returns the process-active plugin registry when one has been loaded. */
export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

function normalizeRequiredPluginIds(ids?: readonly string[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return normalizeSortedUniqueStringEntries(ids);
}

/** Checks whether a registry has the required plugin ids loaded on any runtime surface. */
export function registryContainsRuntimePluginIds(
  registry: PluginRegistry,
  pluginIds: readonly string[] | undefined,
): boolean {
  if (pluginIds === undefined) {
    return true;
  }
  const present = new Set<string>();
  const loaded = new Set<string>();
  const pluginStatusById = new Map<string, string | undefined>();
  for (const plugin of registry.plugins ?? []) {
    present.add(plugin.id);
    pluginStatusById.set(plugin.id, plugin.status);
    if (plugin.status === undefined || plugin.status === "loaded") {
      loaded.add(plugin.id);
    }
  }
  for (const [key, value] of Object.entries(registry)) {
    if (key === "diagnostics" || key === "channelSetups") {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    // Some runtime surfaces store plugin ownership on contribution arrays rather
    // than registry.plugins, so include loaded contribution pluginIds as present.
    for (const entry of value) {
      if (entry && typeof entry === "object" && "pluginId" in entry) {
        const pluginId = entry.pluginId;
        if (typeof pluginId === "string" && pluginId.length > 0) {
          present.add(pluginId);
          const status = pluginStatusById.get(pluginId);
          if (status === undefined || status === "loaded") {
            loaded.add(pluginId);
          }
        }
      }
    }
  }
  if (pluginIds.length === 0) {
    return present.size === 0;
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

/** Returns a loaded runtime registry only when workspace and required ids match. */
export function getLoadedRuntimePluginRegistry(
  params: {
    env?: NodeJS.ProcessEnv;
    loadOptions?: PluginLoadOptions;
    workspaceDir?: string;
    requiredPluginIds?: readonly string[];
    surface?: ActiveRuntimePluginRegistrySurface;
  } = {},
): PluginRegistry | undefined {
  const surface = params.surface ?? "active";
  const requiredPluginIds = normalizeRequiredPluginIds(
    params.requiredPluginIds ?? params.loadOptions?.onlyPluginIds,
  );
  if (surface === "active" && params.loadOptions && requiredPluginIds?.length !== 0) {
    // Compatible registries can be reused for active-surface loads, but only
    // when the caller did not request an explicit empty plugin set.
    const compatible = resolveCompatibleRuntimePluginRegistry(params.loadOptions);
    if (!compatible || !registryContainsRuntimePluginIds(compatible, requiredPluginIds)) {
      return undefined;
    }
    return compatible;
  }

  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  const requestedWorkspaceDir = params.workspaceDir ?? params.loadOptions?.workspaceDir;
  if (requestedWorkspaceDir !== undefined && activeWorkspaceDir !== requestedWorkspaceDir) {
    return undefined;
  }
  const registry = resolveSurfaceRegistry(surface);
  if (!registry) {
    return undefined;
  }
  if (!registryContainsRuntimePluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
