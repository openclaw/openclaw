import { getChannelPlugin } from "./registry.js";
export async function createChannelConversationBindingManager(params) {
    const createManager = getChannelPlugin(params.channelId)?.conversationBindings?.createManager;
    if (!createManager) {
        return null;
    }
    return await createManager({
        cfg: params.cfg,
        accountId: params.accountId,
    });
}
export function setChannelConversationBindingIdleTimeoutBySessionKey(params) {
    const setIdleTimeoutBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
        ?.setIdleTimeoutBySessionKey;
    if (!setIdleTimeoutBySessionKey) {
        return [];
    }
    return setIdleTimeoutBySessionKey({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
    });
}
export function setChannelConversationBindingMaxAgeBySessionKey(params) {
    const setMaxAgeBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
        ?.setMaxAgeBySessionKey;
    if (!setMaxAgeBySessionKey) {
        return [];
    }
    return setMaxAgeBySessionKey({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
    });
}
