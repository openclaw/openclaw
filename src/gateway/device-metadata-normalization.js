function normalizeTrimmedMetadata(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : "";
}
function toLowerAscii(input) {
    return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}
export function normalizeDeviceMetadataForAuth(value) {
    const trimmed = normalizeTrimmedMetadata(value);
    if (!trimmed) {
        return "";
    }
    // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin) by only
    // lowercasing ASCII metadata fields used in auth payloads.
    return toLowerAscii(trimmed);
}
export function normalizeDeviceMetadataForPolicy(value) {
    const trimmed = normalizeTrimmedMetadata(value);
    if (!trimmed) {
        return "";
    }
    // Policy classification should collapse Unicode confusables to stable ASCII-ish
    // tokens where possible before matching platform/family rules.
    return trimmed.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
