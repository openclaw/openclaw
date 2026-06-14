// Stores active runtime plugin registry state and activation metadata.
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

const UNREADABLE_RUNTIME_PLUGIN_STATUS = "__openclaw_unreadable__";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

function normalizeRequiredPluginIds(ids?: readonly string[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return normalizeSortedUniqueStringEntries(ids);
}

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
  let hasUnreadableRuntimeEntry = false;
  for (const plugin of registry.plugins ?? []) {
    let pluginId: unknown;
    try {
      pluginId = plugin.id;
    } catch {
      hasUnreadableRuntimeEntry = true;
      continue;
    }
    if (typeof pluginId === "string" && pluginId.length > 0) {
      present.add(pluginId);
      let status: string | undefined;
      try {
        status = plugin.status;
      } catch {
        pluginStatusById.set(pluginId, UNREADABLE_RUNTIME_PLUGIN_STATUS);
        continue;
      }
      pluginStatusById.set(pluginId, status);
      if (status === undefined || status === "loaded") {
        loaded.add(pluginId);
      }
    }
  }
  for (const [key, value] of Object.entries(registry)) {
    if (key === "diagnostics" || key === "channelSetups") {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      let pluginId: unknown;
      try {
        if (entry && typeof entry === "object" && "pluginId" in entry) {
          pluginId = entry.pluginId;
        }
      } catch {
        hasUnreadableRuntimeEntry = true;
        continue;
      }
      if (typeof pluginId === "string" && pluginId.length > 0) {
        present.add(pluginId);
        const status = pluginStatusById.get(pluginId);
        if (status === undefined || status === "loaded") {
          loaded.add(pluginId);
        }
      }
    }
  }
  if (pluginIds.length === 0) {
    return present.size === 0 && !hasUnreadableRuntimeEntry;
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
