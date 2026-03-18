import { listChannelPluginsFromRegistry } from "../channels/plugins/index.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "../plugins/runtime.js";

export type ChannelLifecyclePluginRuntimeState = {
  registry: PluginRegistry;
  cacheKey: string | null;
};

function collectChannelIds(registry: PluginRegistry): Set<string> {
  return new Set(listChannelPluginsFromRegistry(registry).map((plugin) => plugin.id));
}

export function resolveChannelLifecyclePluginRuntimeState(
  current: ChannelLifecyclePluginRuntimeState,
): ChannelLifecyclePluginRuntimeState {
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return current;
  }

  const activeCacheKey = getActivePluginRegistryKey();
  if (activeRegistry === current.registry) {
    return current.cacheKey === activeCacheKey
      ? current
      : { registry: activeRegistry, cacheKey: activeCacheKey };
  }

  const currentChannelIds = collectChannelIds(current.registry);
  const activeChannelIds = collectChannelIds(activeRegistry);

  // Channel lifecycle rebinds must follow legitimate live registry upgrades,
  // including same-channel replacements that add tools/providers/hooks, but
  // should still refuse active snapshots that would drop known channels.
  for (const channelId of currentChannelIds) {
    if (!activeChannelIds.has(channelId)) {
      return current;
    }
  }

  return { registry: activeRegistry, cacheKey: activeCacheKey };
}
