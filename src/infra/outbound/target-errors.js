export function missingTargetMessage(provider, hint) {
    return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}
export function missingTargetError(provider, hint) {
    return new Error(missingTargetMessage(provider, hint));
}
export function ambiguousTargetMessage(provider, raw, hint) {
    return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}
export function ambiguousTargetError(provider, raw, hint) {
    return new Error(ambiguousTargetMessage(provider, raw, hint));
}
export function unknownTargetMessage(provider, raw, hint) {
    return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}
export function unknownTargetError(provider, raw, hint) {
    return new Error(unknownTargetMessage(provider, raw, hint));
}
function formatTargetHint(hint, withLabel = false) {
    if (!hint) {
        return "";
    }
    return withLabel ? ` Hint: ${hint}` : ` ${hint}`;
}
