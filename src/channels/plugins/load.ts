import type { PluginRegistry } from "../../plugins/registry.js";
import type { ChannelId, ChannelPlugin } from "./types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";

const cache = new Map<ChannelId, ChannelPlugin>();
let lastRegistry: PluginRegistry | null = null;

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === lastRegistry) {
    return;
  }
  cache.clear();
  lastRegistry = registry;
}

export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  if (pluginEntry) {
    cache.set(id, pluginEntry.plugin);
    return pluginEntry.plugin;
  }
  return undefined;
}
