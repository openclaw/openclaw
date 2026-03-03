export function normalizeNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
export function normalizeStringArray(value) {
    return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
