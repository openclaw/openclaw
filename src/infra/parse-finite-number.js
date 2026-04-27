function normalizeNumericString(value) {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
export function parseFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
export function parseStrictInteger(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) ? value : undefined;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = normalizeNumericString(value);
    if (!normalized || !/^[+-]?\d+$/.test(normalized)) {
        return undefined;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
export function parseStrictPositiveInteger(value) {
    const parsed = parseStrictInteger(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
export function parseStrictNonNegativeInteger(value) {
    const parsed = parseStrictInteger(value);
    return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}
