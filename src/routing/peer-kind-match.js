export function peerKindMatches(bindingKind, scopeKind) {
    if (bindingKind === scopeKind) {
        return true;
    }
    return ((bindingKind === "group" && scopeKind === "channel") ||
        (bindingKind === "channel" && scopeKind === "group"));
}
