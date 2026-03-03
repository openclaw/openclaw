export function shouldAckReaction(params) {
    const scope = params.scope ?? "group-mentions";
    if (scope === "off" || scope === "none") {
        return false;
    }
    if (scope === "all") {
        return true;
    }
    if (scope === "direct") {
        return params.isDirect;
    }
    if (scope === "group-all") {
        return params.isGroup;
    }
    if (scope === "group-mentions") {
        if (!params.isMentionableGroup) {
            return false;
        }
        if (!params.requireMention) {
            return false;
        }
        if (!params.canDetectMention) {
            return false;
        }
        return params.effectiveWasMentioned || params.shouldBypassMention === true;
    }
    return false;
}
export function shouldAckReactionForWhatsApp(params) {
    if (!params.emoji) {
        return false;
    }
    if (params.isDirect) {
        return params.directEnabled;
    }
    if (!params.isGroup) {
        return false;
    }
    if (params.groupMode === "never") {
        return false;
    }
    if (params.groupMode === "always") {
        return true;
    }
    return shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: params.wasMentioned,
        shouldBypassMention: params.groupActivated,
    });
}
export function removeAckReactionAfterReply(params) {
    if (!params.removeAfterReply) {
        return;
    }
    if (!params.ackReactionPromise) {
        return;
    }
    if (!params.ackReactionValue) {
        return;
    }
    void params.ackReactionPromise.then((didAck) => {
        if (!didAck) {
            return;
        }
        params.remove().catch((err) => params.onError?.(err));
    });
}
