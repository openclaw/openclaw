import { getChannelPlugin, normalizeChannelId } from "./registry.js";
export function resolveChannelConfiguredBindingProvider(plugin) {
    return plugin?.bindings;
}
export function resolveChannelConfiguredBindingProviderByChannel(channel) {
    const normalizedChannel = normalizeChannelId(channel);
    if (!normalizedChannel) {
        return undefined;
    }
    return resolveChannelConfiguredBindingProvider(getChannelPlugin(normalizedChannel));
}
