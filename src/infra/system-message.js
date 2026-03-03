export const SYSTEM_MARK = "⚙️";
function normalizeSystemText(value) {
    return value.trim();
}
export function hasSystemMark(text) {
    return normalizeSystemText(text).startsWith(SYSTEM_MARK);
}
export function prefixSystemMessage(text) {
    const normalized = normalizeSystemText(text);
    if (!normalized) {
        return normalized;
    }
    if (hasSystemMark(normalized)) {
        return normalized;
    }
    return `${SYSTEM_MARK} ${normalized}`;
}
