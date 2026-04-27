import { normalizeOptionalString } from "../shared/string-coerce.js";
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol("openclaw.implicitSameChatApprovalAuthorization");
function markImplicitSameChatApprovalAuthorization(result) {
    // Keep this non-enumerable to avoid changing auth payload shape.
    // Consumers must pass the same object reference to
    // `isImplicitSameChatApprovalAuthorization`; spread/Object.assign/JSON clones
    // drop this marker.
    Object.defineProperty(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION, {
        value: true,
        enumerable: false,
    });
    return result;
}
export function isImplicitSameChatApprovalAuthorization(result) {
    return Boolean(result &&
        result[IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION]);
}
export function createResolvedApproverActionAuthAdapter(params) {
    const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;
    return {
        authorizeActorAction({ cfg, accountId, senderId, approvalKind, }) {
            const approvers = params.resolveApprovers({ cfg, accountId });
            if (approvers.length === 0) {
                // Empty approver sets are implicit same-chat fallback, not explicit approver bypass.
                return markImplicitSameChatApprovalAuthorization({ authorized: true });
            }
            const normalizedSenderId = senderId ? normalizeSenderId(senderId) : undefined;
            if (normalizedSenderId && approvers.includes(normalizedSenderId)) {
                return { authorized: true };
            }
            return {
                authorized: false,
                reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
            };
        },
    };
}
