import { CHAT_CHANNEL_ORDER } from "../channels/registry.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";

export function resolveCliChannelOptions(): string[] {
  if (isTruthyEnvValue(process.env.CLAWDBOT_EAGER_CHANNEL_OPTIONS)) {
    ensurePluginRegistryLoaded();
    return listChannelPlugins().map((plugin) => plugin.id);
  }
  return [...CHAT_CHANNEL_ORDER];
}

export function formatCliChannelOptions(extra: string[] = []): string {
  return [...extra, ...resolveCliChannelOptions()].join("|");
}
