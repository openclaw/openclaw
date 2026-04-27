import { countCompiledBindingRegistry, primeCompiledBindingRegistry, resolveCompiledBindingRegistry, } from "./configured-binding-compiler.js";
import { materializeConfiguredBindingRecord, resolveMatchingConfiguredBinding, toConfiguredBindingConversationRef, } from "./configured-binding-match.js";
import { resolveConfiguredBindingRecordBySessionKeyFromRegistry } from "./configured-binding-session-lookup.js";
function resolveMaterializedConfiguredBinding(params) {
    const conversation = toConfiguredBindingConversationRef(params.conversation);
    if (!conversation) {
        return null;
    }
    const rules = resolveCompiledBindingRegistry(params.cfg).rulesByChannel.get(conversation.channel);
    if (!rules || rules.length === 0) {
        return null;
    }
    const resolved = resolveMatchingConfiguredBinding({
        rules,
        conversation,
    });
    if (!resolved) {
        return null;
    }
    return {
        conversation,
        resolved,
        materializedTarget: materializeConfiguredBindingRecord({
            rule: resolved.rule,
            accountId: conversation.accountId,
            conversation: resolved.match,
        }),
    };
}
export function primeConfiguredBindingRegistry(params) {
    return countCompiledBindingRegistry(primeCompiledBindingRegistry(params.cfg));
}
export function resolveConfiguredBindingRecord(params) {
    const conversation = toConfiguredBindingConversationRef({
        channel: params.channel,
        accountId: params.accountId,
        conversationId: params.conversationId,
        parentConversationId: params.parentConversationId,
    });
    if (!conversation) {
        return null;
    }
    return resolveConfiguredBindingRecordForConversation({
        cfg: params.cfg,
        conversation,
    });
}
export function resolveConfiguredBindingRecordForConversation(params) {
    const resolved = resolveMaterializedConfiguredBinding(params);
    if (!resolved) {
        return null;
    }
    return resolved.materializedTarget;
}
export function resolveConfiguredBinding(params) {
    const resolved = resolveMaterializedConfiguredBinding(params);
    if (!resolved) {
        return null;
    }
    return {
        conversation: resolved.conversation,
        compiledBinding: resolved.resolved.rule,
        match: resolved.resolved.match,
        ...resolved.materializedTarget,
    };
}
export function resolveConfiguredBindingRecordBySessionKey(params) {
    return resolveConfiguredBindingRecordBySessionKeyFromRegistry({
        registry: resolveCompiledBindingRegistry(params.cfg),
        sessionKey: params.sessionKey,
    });
}
