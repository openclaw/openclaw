import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { isDeliverableMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel.js";
import { bootstrapOutboundChannelPlugin, resetOutboundChannelBootstrapStateForTests, } from "./channel-bootstrap.runtime.js";
export function resetOutboundChannelResolutionStateForTest() {
    resetOutboundChannelBootstrapStateForTests();
}
export function normalizeDeliverableOutboundChannel(raw) {
    const normalized = normalizeMessageChannel(raw);
    if (!normalized || !isDeliverableMessageChannel(normalized)) {
        return undefined;
    }
    return normalized;
}
function maybeBootstrapChannelPlugin(params) {
    bootstrapOutboundChannelPlugin(params);
}
function resolveDirectFromActiveRegistry(channel) {
    const activeRegistry = getActivePluginRegistry();
    if (!activeRegistry) {
        return undefined;
    }
    for (const entry of activeRegistry.channels) {
        const plugin = entry?.plugin;
        if (plugin?.id === channel) {
            return plugin;
        }
    }
    return undefined;
}
export function resolveOutboundChannelPlugin(params) {
    const normalized = normalizeDeliverableOutboundChannel(params.channel);
    if (!normalized) {
        return undefined;
    }
    const resolveLoaded = () => getLoadedChannelPlugin(normalized);
    const resolve = () => getChannelPlugin(normalized);
    const current = resolveLoaded();
    if (current) {
        return current;
    }
    const directCurrent = resolveDirectFromActiveRegistry(normalized);
    if (directCurrent) {
        return directCurrent;
    }
    maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
    return resolveLoaded() ?? resolveDirectFromActiveRegistry(normalized) ?? resolve();
}
