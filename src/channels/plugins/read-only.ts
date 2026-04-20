import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listPotentialConfiguredChannelIds } from "../config-presence.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPlugin[] {
  const byId = new Map<string, ChannelPlugin>();

  for (const plugin of listChannelPlugins()) {
    byId.set(plugin.id, plugin);
  }

  for (const channelId of listPotentialConfiguredChannelIds(cfg, env)) {
    if (byId.has(channelId)) {
      continue;
    }
    const setupPlugin = getBundledChannelSetupPlugin(channelId);
    if (setupPlugin) {
      byId.set(setupPlugin.id, setupPlugin);
    }
  }

  return [...byId.values()];
}
