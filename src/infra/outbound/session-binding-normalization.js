import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function normalizeConversationTargetRef(ref) {
    const conversationId = normalizeOptionalString(ref.conversationId) ?? "";
    const parentConversationId = normalizeOptionalString(ref.parentConversationId);
    const { parentConversationId: _ignoredParentConversationId, ...rest } = ref;
    return {
        ...rest,
        conversationId,
        ...(parentConversationId && parentConversationId !== conversationId
            ? { parentConversationId }
            : {}),
    };
}
export function normalizeConversationRef(ref) {
    const normalizedTarget = normalizeConversationTargetRef(ref);
    return {
        ...normalizedTarget,
        channel: normalizeLowercaseStringOrEmpty(ref.channel),
        accountId: normalizeAccountId(ref.accountId),
    };
}
export function buildChannelAccountKey(params) {
    return `${normalizeLowercaseStringOrEmpty(params.channel)}:${normalizeAccountId(params.accountId)}`;
}
