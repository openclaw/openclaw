import { getChatChannelMeta } from "../channels/chat-meta.js";
import { getRegisteredChannelPluginMeta, normalizeChatChannelId } from "../channels/registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, normalizeGatewayClientMode, normalizeGatewayClientName, } from "../gateway/protocol/client-info.js";
export { isDeliverableMessageChannel, isGatewayMessageChannel, listDeliverableMessageChannels, listGatewayAgentChannelAliases, listGatewayAgentChannelValues, listGatewayMessageChannels, normalizeMessageChannel, resolveGatewayMessageChannel, resolveMessageChannel, } from "./message-channel-normalize.js";
export { INTERNAL_MESSAGE_CHANNEL, } from "./message-channel-constants.js";
import { INTERNAL_MESSAGE_CHANNEL, } from "./message-channel-constants.js";
import { normalizeMessageChannel, } from "./message-channel-normalize.js";
export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export { normalizeGatewayClientName, normalizeGatewayClientMode };
export function isGatewayCliClient(client) {
    return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}
export function isOperatorUiClient(client) {
    const clientId = normalizeGatewayClientName(client?.id);
    return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI;
}
export function isBrowserOperatorUiClient(client) {
    const clientId = normalizeGatewayClientName(client?.id);
    return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI;
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
export function isMarkdownCapableMessageChannel(raw) {
    const channel = normalizeMessageChannel(raw);
    if (!channel) {
        return false;
    }
    if (channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
        return true;
    }
    const builtInChannel = normalizeChatChannelId(channel);
    if (builtInChannel) {
        return getChatChannelMeta(builtInChannel).markdownCapable === true;
    }
    return getRegisteredChannelPluginMeta(channel)?.markdownCapable === true;
}
