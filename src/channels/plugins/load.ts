import type { ChannelId, ChannelPlugin } from "./types.js";
import { createChannelRegistryLoader } from "./registry-loader.js";

const loadPluginFromRegistry = createChannelRegistryLoader<ChannelPlugin>((entry) => entry.plugin);

export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  return loadPluginFromRegistry(id);
}
