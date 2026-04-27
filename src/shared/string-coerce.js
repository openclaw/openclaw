export function readStringValue(value) {
    return typeof value === "string" ? value : undefined;
}
export function normalizeNullableString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
export function normalizeOptionalString(value) {
    return normalizeNullableString(value) ?? undefined;
}
export function normalizeStringifiedOptionalString(value) {
    if (typeof value === "string") {
        return normalizeOptionalString(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return normalizeOptionalString(String(value));
    }
    return undefined;
}
export function normalizeOptionalLowercaseString(value) {
    return normalizeOptionalString(value)?.toLowerCase();
}
export function normalizeLowercaseStringOrEmpty(value) {
    return normalizeOptionalLowercaseString(value) ?? "";
}
export function normalizeFastMode(raw) {
    if (typeof raw === "boolean") {
        return raw;
    }
    if (!raw) {
        return undefined;
    }
    const key = normalizeLowercaseStringOrEmpty(raw);
    if (["off", "false", "no", "0", "disable", "disabled", "normal"].includes(key)) {
        return false;
    }
    if (["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(key)) {
        return true;
    }
    return undefined;
}
export function lowercasePreservingWhitespace(value) {
    return value.toLowerCase();
}
export function localeLowercasePreservingWhitespace(value) {
    return value.toLocaleLowerCase();
}
export function resolvePrimaryStringValue(value) {
    if (typeof value === "string") {
        return normalizeOptionalString(value);
    }
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return normalizeOptionalString(value.primary);
}
export function normalizeOptionalThreadValue(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? Math.trunc(value) : undefined;
    }
    return normalizeOptionalString(value);
}
export function normalizeOptionalStringifiedId(value) {
    const normalized = normalizeOptionalThreadValue(value);
    return normalized == null ? undefined : String(normalized);
}
export function hasNonEmptyString(value) {
    return normalizeOptionalString(value) !== undefined;
}
