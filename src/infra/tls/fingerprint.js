import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
export function normalizeFingerprint(input) {
    const trimmed = input.trim();
    const withoutPrefix = trimmed.replace(/^sha-?256\s*:?\s*/i, "");
    return normalizeLowercaseStringOrEmpty(withoutPrefix.replace(/[^a-fA-F0-9]/g, ""));
}
