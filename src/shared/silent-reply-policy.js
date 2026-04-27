import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
export const DEFAULT_SILENT_REPLY_POLICY = {
    direct: "disallow",
    group: "allow",
    internal: "allow",
};
export const DEFAULT_SILENT_REPLY_REWRITE = {
    direct: true,
    group: false,
    internal: false,
};
const SILENT_REPLY_REWRITE_TEXTS = [
    "Nothing to add right now.",
    "All quiet on my side.",
    "No extra notes from me.",
    "Standing by.",
    "No update from me on this one.",
    "Nothing further to report.",
    "I have nothing else to add.",
    "No follow-up needed from me.",
    "No additional reply from me here.",
    "No extra comment on my end.",
    "No further note from me.",
    "That is all from me for now.",
    "No added response from me.",
    "Nothing else to say here.",
    "No extra message needed from me.",
    "No additional note on this one.",
    "No further response from me.",
    "Nothing new to add from my side.",
    "No extra update from me.",
    "I have no further reply here.",
    "Nothing additional from me.",
    "No added note from my side.",
    "No more to report from me.",
    "No extra reply needed here.",
    "No further word from me.",
    "Nothing further on my end.",
    "No extra answer from me.",
    "No additional response from my side.",
];
function hashSeed(seed) {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return hash;
}
export function classifySilentReplyConversationType(params) {
    if (params.conversationType) {
        return params.conversationType;
    }
    const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
    if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) {
        return "group";
    }
    if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) {
        return "direct";
    }
    const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
    if (normalizedSurface === "webchat") {
        return "direct";
    }
    return "internal";
}
export function resolveSilentReplyPolicyFromPolicies(params) {
    return (params.surfacePolicy?.[params.conversationType] ??
        params.defaultPolicy?.[params.conversationType] ??
        DEFAULT_SILENT_REPLY_POLICY[params.conversationType]);
}
export function resolveSilentReplyRewriteFromPolicies(params) {
    return (params.surfaceRewrite?.[params.conversationType] ??
        params.defaultRewrite?.[params.conversationType] ??
        DEFAULT_SILENT_REPLY_REWRITE[params.conversationType]);
}
export function resolveSilentReplyRewriteText(params) {
    const seed = params.seed?.trim() || "silent-reply";
    const index = hashSeed(seed) % SILENT_REPLY_REWRITE_TEXTS.length;
    return SILENT_REPLY_REWRITE_TEXTS[index] ?? SILENT_REPLY_REWRITE_TEXTS[0];
}
