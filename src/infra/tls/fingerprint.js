export function normalizeFingerprint(input) {
    const trimmed = input.trim();
    const withoutPrefix = trimmed.replace(/^sha-?256\s*:?\s*/i, "");
    return withoutPrefix.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}
