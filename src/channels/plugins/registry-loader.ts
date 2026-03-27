import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue>();
  let lastRegistry: PluginRegistry | null = null;
  let lastChannelVersion = -1;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginRegistry();
    const channelVersion = getActivePluginChannelRegistryVersion();
    if (registry !== lastRegistry || channelVersion !== lastChannelVersion) {
      cache.clear();
      lastRegistry = registry;
      lastChannelVersion = channelVersion;
    }
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    // Fall back to the channel-surface registry when the active registry does
    // not contain the requested channel.  The channel surface is pinned at
    // gateway startup and is immune to later non-primary plugin reloads (e.g.
    // config-schema reads, provider snapshots) that can replace the active
    // registry with a minimal set that omits channel plugins.  This mirrors
    // what `getChannelPlugin` already does via `requireActivePluginChannelRegistry`.
    // See: https://github.com/openclaw/openclaw/issues/12769
    const effectiveEntry =
      pluginEntry ?? resolveFromChannelSurface(id, registry);
    if (!effectiveEntry) {
      return undefined;
    }
    const resolved = resolveValue(effectiveEntry);
    if (resolved) {
      cache.set(id, resolved);
    }
    return resolved;
  };
}

function resolveFromChannelSurface(
  id: ChannelId,
  activeRegistry: PluginRegistry | null,
): PluginChannelRegistration | undefined {
  const channelRegistry = getActivePluginChannelRegistry();
  // Only fall back when the channel surface is a different (pinned) registry.
  if (!channelRegistry || channelRegistry === activeRegistry) {
    return undefined;
  }
  return channelRegistry.channels.find((entry) => entry.plugin.id === id);
}
