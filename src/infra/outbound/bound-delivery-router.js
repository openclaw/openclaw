import { getSessionBindingService, } from "./session-binding-service.js";
function isActiveBinding(record) {
    return record.status === "active";
}
function resolveBindingForRequester(requester, bindings) {
    const matchingChannelAccount = bindings.filter((entry) => entry.conversation.channel === requester.channel &&
        entry.conversation.accountId === requester.accountId);
    if (matchingChannelAccount.length === 0) {
        return null;
    }
    const exactConversation = matchingChannelAccount.find((entry) => entry.conversation.conversationId === requester.conversationId);
    if (exactConversation) {
        return exactConversation;
    }
    if (matchingChannelAccount.length === 1) {
        return matchingChannelAccount[0] ?? null;
    }
    return null;
}
export function createBoundDeliveryRouter(service = getSessionBindingService()) {
    return {
        resolveDestination: (input) => {
            const targetSessionKey = input.targetSessionKey.trim();
            if (!targetSessionKey) {
                return {
                    binding: null,
                    mode: "fallback",
                    reason: "missing-target-session",
                };
            }
            const activeBindings = service.listBySession(targetSessionKey).filter(isActiveBinding);
            if (activeBindings.length === 0) {
                return {
                    binding: null,
                    mode: "fallback",
                    reason: "no-active-binding",
                };
            }
            if (!input.requester) {
                if (activeBindings.length === 1) {
                    return {
                        binding: activeBindings[0] ?? null,
                        mode: "bound",
                        reason: "single-active-binding",
                    };
                }
                return {
                    binding: null,
                    mode: "fallback",
                    reason: "ambiguous-without-requester",
                };
            }
            const requester = {
                channel: input.requester.channel.trim().toLowerCase(),
                accountId: input.requester.accountId.trim(),
                conversationId: input.requester.conversationId.trim(),
                parentConversationId: input.requester.parentConversationId?.trim() || undefined,
            };
            if (!requester.channel || !requester.conversationId) {
                return {
                    binding: null,
                    mode: "fallback",
                    reason: "invalid-requester",
                };
            }
            const fromRequester = resolveBindingForRequester(requester, activeBindings);
            if (fromRequester) {
                return {
                    binding: fromRequester,
                    mode: "bound",
                    reason: "requester-match",
                };
            }
            if (activeBindings.length === 1 && !input.failClosed) {
                return {
                    binding: activeBindings[0] ?? null,
                    mode: "bound",
                    reason: "single-active-binding-fallback",
                };
            }
            return {
                binding: null,
                mode: "fallback",
                reason: "no-requester-match",
            };
        },
    };
}
