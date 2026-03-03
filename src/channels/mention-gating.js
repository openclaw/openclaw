export function resolveMentionGating(params) {
    const implicit = params.implicitMention === true;
    const bypass = params.shouldBypassMention === true;
    const effectiveWasMentioned = params.wasMentioned || implicit || bypass;
    const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
    return { effectiveWasMentioned, shouldSkip };
}
export function resolveMentionGatingWithBypass(params) {
    const shouldBypassMention = params.isGroup &&
        params.requireMention &&
        !params.wasMentioned &&
        !(params.hasAnyMention ?? false) &&
        params.allowTextCommands &&
        params.commandAuthorized &&
        params.hasControlCommand;
    return {
        ...resolveMentionGating({
            requireMention: params.requireMention,
            canDetectMention: params.canDetectMention,
            wasMentioned: params.wasMentioned,
            implicitMention: params.implicitMention,
            shouldBypassMention,
        }),
        shouldBypassMention,
    };
}
