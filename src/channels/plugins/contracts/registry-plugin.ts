import { listBundledChannelPlugins } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

let pluginContractRegistryCache: PluginContractEntry[] | undefined;

export function getPluginContractRegistry(): PluginContractEntry[] {
  pluginContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
  }));
  return pluginContractRegistryCache;
}
