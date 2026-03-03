import { CHANNEL_IDS, listChatChannelAliases, normalizeChatChannelId, } from "../channels/registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, normalizeGatewayClientMode, normalizeGatewayClientName, } from "../gateway/protocol/client-info.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
export const INTERNAL_MESSAGE_CHANNEL = "webchat";
const MARKDOWN_CAPABLE_CHANNELS = new Set([
    "slack",
    "telegram",
    "signal",
    "discord",
    "googlechat",
    "tui",
    INTERNAL_MESSAGE_CHANNEL,
]);
export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export { normalizeGatewayClientName, normalizeGatewayClientMode };
export function isGatewayCliClient(client) {
    return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}
export function isInternalMessageChannel(raw) {
    return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}
export function isWebchatClient(client) {
    const mode = normalizeGatewayClientMode(client?.mode);
    if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
        return true;
    }
    return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}
export function normalizeMessageChannel(raw) {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (normalized === INTERNAL_MESSAGE_CHANNEL) {
        return INTERNAL_MESSAGE_CHANNEL;
    }
    const builtIn = normalizeChatChannelId(normalized);
    if (builtIn) {
        return builtIn;
    }
    const registry = getActivePluginRegistry();
    const pluginMatch = registry?.channels.find((entry) => {
        if (entry.plugin.id.toLowerCase() === normalized) {
            return true;
        }
        return (entry.plugin.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized);
    });
    return pluginMatch?.plugin.id ?? normalized;
}
const listPluginChannelIds = () => {
    const registry = getActivePluginRegistry();
    if (!registry) {
        return [];
    }
    return registry.channels.map((entry) => entry.plugin.id);
};
const listPluginChannelAliases = () => {
    const registry = getActivePluginRegistry();
    if (!registry) {
        return [];
    }
    return registry.channels.flatMap((entry) => entry.plugin.meta.aliases ?? []);
};
export const listDeliverableMessageChannels = () => Array.from(new Set([...CHANNEL_IDS, ...listPluginChannelIds()]));
export const listGatewayMessageChannels = () => [
    ...listDeliverableMessageChannels(),
    INTERNAL_MESSAGE_CHANNEL,
];
export const listGatewayAgentChannelAliases = () => Array.from(new Set([...listChatChannelAliases(), ...listPluginChannelAliases()]));
export const listGatewayAgentChannelValues = () => Array.from(new Set([...listGatewayMessageChannels(), "last", ...listGatewayAgentChannelAliases()]));
export function isGatewayMessageChannel(value) {
    return listGatewayMessageChannels().includes(value);
}
export function isDeliverableMessageChannel(value) {
    return listDeliverableMessageChannels().includes(value);
}
export function resolveGatewayMessageChannel(raw) {
    const normalized = normalizeMessageChannel(raw);
    if (!normalized) {
        return undefined;
    }
    return isGatewayMessageChannel(normalized) ? normalized : undefined;
}
export function resolveMessageChannel(primary, fallback) {
    return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
export function isMarkdownCapableMessageChannel(raw) {
    const channel = normalizeMessageChannel(raw);
    if (!channel) {
        return false;
    }
    return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
