export function evaluateSupplementalContextVisibility(params) {
    if (params.mode === "all") {
        return { include: true, reason: "mode_all" };
    }
    if (params.senderAllowed) {
        return { include: true, reason: "sender_allowed" };
    }
    if (params.mode === "allowlist_quote" && params.kind === "quote") {
        return { include: true, reason: "quote_override" };
    }
    return { include: false, reason: "blocked" };
}
export function shouldIncludeSupplementalContext(params) {
    return evaluateSupplementalContextVisibility(params).include;
}
export function filterSupplementalContextItems(params) {
    const items = params.items.filter((item) => shouldIncludeSupplementalContext({
        mode: params.mode,
        kind: params.kind,
        senderAllowed: params.isSenderAllowed(item),
    }));
    return {
        items,
        omitted: params.items.length - items.length,
    };
}
