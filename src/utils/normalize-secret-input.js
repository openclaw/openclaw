/**
 * Secret normalization for copy/pasted credentials.
 *
 * Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
 * We strip line breaks anywhere, then trim whitespace at the ends.
 *
 * Intentionally does NOT remove ordinary spaces inside the string to avoid
 * silently altering "Bearer <token>" style values.
 */
export function normalizeSecretInput(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}
export function normalizeOptionalSecretInput(value) {
    const normalized = normalizeSecretInput(value);
    return normalized ? normalized : undefined;
}
