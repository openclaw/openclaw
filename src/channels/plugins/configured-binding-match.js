import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function resolveAccountMatchPriority(match, actual) {
    const trimmed = (match ?? "").trim();
    if (!trimmed) {
        return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
    }
    if (trimmed === "*") {
        return 1;
    }
    return normalizeAccountId(trimmed) === actual ? 2 : 0;
}
function matchCompiledBindingConversation(params) {
    return params.rule.provider.matchInboundConversation({
        binding: params.rule.binding,
        compiledBinding: params.rule.target,
        conversationId: params.conversationId,
        parentConversationId: params.parentConversationId,
    });
}
export function resolveCompiledBindingChannel(raw) {
    const normalized = normalizeOptionalLowercaseString(raw);
    return normalized ? normalized : null;
}
export function toConfiguredBindingConversationRef(conversation) {
    const channel = resolveCompiledBindingChannel(conversation.channel);
    const conversationId = conversation.conversationId.trim();
    if (!channel || !conversationId) {
        return null;
    }
    return {
        channel,
        accountId: normalizeAccountId(conversation.accountId),
        conversationId,
        parentConversationId: normalizeOptionalString(conversation.parentConversationId),
    };
}
export function materializeConfiguredBindingRecord(params) {
    return params.rule.targetFactory.materialize({
        accountId: normalizeAccountId(params.accountId),
        conversation: params.conversation,
    });
}
export function resolveMatchingConfiguredBinding(params) {
    if (!params.conversation) {
        return null;
    }
    let wildcardMatch = null;
    let exactMatch = null;
    for (const rule of params.rules) {
        const accountMatchPriority = resolveAccountMatchPriority(rule.accountPattern, params.conversation.accountId);
        if (accountMatchPriority === 0) {
            continue;
        }
        const match = matchCompiledBindingConversation({
            rule,
            conversationId: params.conversation.conversationId,
            parentConversationId: params.conversation.parentConversationId,
        });
        if (!match) {
            continue;
        }
        const matchPriority = match.matchPriority ?? 0;
        if (accountMatchPriority === 2) {
            if (!exactMatch || matchPriority > (exactMatch.match.matchPriority ?? 0)) {
                exactMatch = { rule, match };
            }
            continue;
        }
        if (!wildcardMatch || matchPriority > (wildcardMatch.match.matchPriority ?? 0)) {
            wildcardMatch = { rule, match };
        }
    }
    return exactMatch ?? wildcardMatch;
}
