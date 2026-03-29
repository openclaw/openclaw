import { getChannelPlugin, normalizeChannelId } from "./registry.js";
import type { ChannelConfiguredBindingProvider } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

export function resolveChannelConfiguredBindingProvider(
  plugin:
    | Pick<ChannelPlugin, "bindings">
    | {
        bindings?: ChannelConfiguredBindingProvider;
      }
    | null
    | undefined,
): ChannelConfiguredBindingProvider | undefined {
  return plugin?.bindings;
}

export function resolveChannelConfiguredBindingProviderByChannel(
  channel: string,
): ChannelConfiguredBindingProvider | undefined {
  const normalizedChannel = normalizeChannelId(channel);
  if (!normalizedChannel) {
    return undefined;
  }
  return resolveChannelConfiguredBindingProvider(getChannelPlugin(normalizedChannel));
}
