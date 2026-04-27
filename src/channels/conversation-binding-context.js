import { resolveCommandConversationResolution, } from "./conversation-resolution.js";
export function resolveConversationBindingContext(params) {
    const resolution = resolveCommandConversationResolution({
        ...params,
        includePlacementHint: false,
    });
    if (!resolution) {
        return null;
    }
    return {
        channel: resolution.canonical.channel,
        accountId: resolution.canonical.accountId,
        conversationId: resolution.canonical.conversationId,
        ...(resolution.canonical.parentConversationId
            ? { parentConversationId: resolution.canonical.parentConversationId }
            : {}),
        ...(resolution.threadId ? { threadId: resolution.threadId } : {}),
    };
}
