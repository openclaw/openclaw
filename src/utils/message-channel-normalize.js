import { CHANNEL_IDS, listChatChannelAliases } from "../channels/ids.js";
import { listRegisteredChannelPluginAliases, listRegisteredChannelPluginIds, } from "../channels/registry.js";
import { INTERNAL_MESSAGE_CHANNEL, } from "./message-channel-constants.js";
import { normalizeMessageChannel as normalizeMessageChannelCore } from "./message-channel-core.js";
export function normalizeMessageChannel(raw) {
    return normalizeMessageChannelCore(raw);
}
const listPluginChannelIds = () => {
    return listRegisteredChannelPluginIds();
};
const listPluginChannelAliases = () => {
    return listRegisteredChannelPluginAliases();
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
