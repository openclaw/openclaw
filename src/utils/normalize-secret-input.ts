/**
 * Patterns that indicate an unresolved secret reference.
 * These should never be sent as actual credentials.
 */
const UNRESOLVED_SECRET_PATTERNS = [
  /^op:\/\//i, // 1Password CLI reference (op://vault/item/field)
  /^secret:\/\//i, // Generic secret:// URI scheme
  /^\$\{[A-Z_][A-Z0-9_]*\}$/, // Environment variable template ${VAR_NAME}
];

/**
 * Check if a value looks like an unresolved secret reference.
 * Returns the pattern name if it matches, undefined otherwise.
 */
export function detectUnresolvedSecretReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (UNRESOLVED_SECRET_PATTERNS[0].test(trimmed)) {
    return "1Password reference (op://)";
  }
  if (UNRESOLVED_SECRET_PATTERNS[1].test(trimmed)) {
    return "secret:// URI";
  }
  if (UNRESOLVED_SECRET_PATTERNS[2].test(trimmed)) {
    return "environment variable template";
  }
  return undefined;
}

/**
 * Secret normalization for copy/pasted credentials.
 *
 * Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
 * We strip line breaks anywhere, then trim whitespace at the ends.
 *
 * Another frequent source of runtime failures is rich-text/Unicode artifacts
 * (smart punctuation, box-drawing chars, etc.) pasted into API keys. These can
 * break HTTP header construction (`ByteString` violations). Drop non-Latin1
 * code points so malformed keys fail as auth errors instead of crashing request
 * setup.
 *
 * Intentionally does NOT remove ordinary spaces inside the string to avoid
 * silently altering "Bearer <token>" style values.
 */
export function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
  let latin1Only = "";
  for (const char of collapsed) {
    const codePoint = char.codePointAt(0);
    if (typeof codePoint === "number" && codePoint <= 0xff) {
      latin1Only += char;
    }
  }
  return latin1Only.trim();
}

export function normalizeOptionalSecretInput(value: unknown): string | undefined {
  const normalized = normalizeSecretInput(value);
  return normalized ? normalized : undefined;
}
