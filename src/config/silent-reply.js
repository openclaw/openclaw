import { classifySilentReplyConversationType, resolveSilentReplyPolicyFromPolicies, resolveSilentReplyRewriteFromPolicies, } from "../shared/silent-reply-policy.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
function resolveSilentReplyConversationContext(params) {
    const conversationType = classifySilentReplyConversationType({
        sessionKey: params.sessionKey,
        surface: params.surface,
        conversationType: params.conversationType,
    });
    const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
    const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
    return {
        conversationType,
        defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
        defaultRewrite: params.cfg?.agents?.defaults?.silentReplyRewrite,
        surfacePolicy: surface?.silentReply,
        surfaceRewrite: surface?.silentReplyRewrite,
    };
}
export function resolveSilentReplySettings(params) {
    const context = resolveSilentReplyConversationContext(params);
    return {
        policy: resolveSilentReplyPolicyFromPolicies(context),
        rewrite: resolveSilentReplyRewriteFromPolicies(context),
    };
}
export function resolveSilentReplyPolicy(params) {
    return resolveSilentReplySettings(params).policy;
}
export function resolveSilentReplyRewriteEnabled(params) {
    return resolveSilentReplySettings(params).rewrite;
}
