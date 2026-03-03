export function trimMessagingTarget(raw) {
    const trimmed = raw.trim();
    return trimmed || undefined;
}
export function looksLikeHandleOrPhoneTarget(params) {
    const trimmed = params.raw.trim();
    if (!trimmed) {
        return false;
    }
    if (params.prefixPattern.test(trimmed)) {
        return true;
    }
    if (trimmed.includes("@")) {
        return true;
    }
    return (params.phonePattern ?? /^\+?\d{3,}$/).test(trimmed);
}
