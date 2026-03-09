/**
 * Secret normalization for copy/pasted credentials.
 *
 * Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
 * We strip all control characters, ANSI escape sequences, and trim whitespace.
 *
 * Strips:
 * - All C0 control characters (U+0000-U+001F): includes \t, \n, \r, \v, \f, etc.
 * - DEL character (U+007F)
 * - All C1 control characters (U+0080-U+009F): includes NEL (U+0085), etc.
 * - Unicode line/paragraph separators (U+2028, U+2029)
 * - ANSI escape sequences (e.g., terminal color codes like \x1B[31m)
 *
 * Another frequent source of runtime failures is rich-text/Unicode artifacts
 * (smart punctuation, box-drawing chars, etc.) pasted into API keys. These can
 * break HTTP header construction (`ByteString` violations). Drop non-Latin1
 * code points so malformed keys fail as auth errors instead of crashing request
 * setup.
 *
 * Intentionally does NOT remove ordinary spaces (U+0020) inside the string to
 * avoid silently altering "Bearer <token>" style values.
 */
export function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // Strip all control characters (C0, DEL, C1) and Unicode line/paragraph separators
  // Also strip ANSI escape sequences (e.g., \x1B[0m, \x1B[31m for terminal colors)
  const collapsed = value
    .replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, "")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
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
