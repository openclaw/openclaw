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
  // Three-step pipeline, each a single regex pass:
  //   1. Strip embedded line breaks (\r, \n, LS U+2028, PS U+2029).
  //   2. Drop non-Latin-1 code points (> U+00FF) that would cause
  //      ByteString violations in HTTP headers.  The character class
  //      Two ranges cover all non-Latin-1 code points:
  //        [\u0100-\uFFFF]  — BMP above Latin-1
  //        [\u{10000}-\u{10FFFF}]  — supplementary planes (emoji, etc.)
  //      Faster than a per-character loop; /gu flag handles surrogate pairs.
  //   3. Trim surrounding whitespace.
  return value
    .replace(/[\r\n\u2028\u2029]+/g, "")
    .replace(/[\u0100-\uFFFF]|[\u{10000}-\u{10FFFF}]/gu, "")
    .trim();
}

export function normalizeOptionalSecretInput(value: unknown): string | undefined {
  const normalized = normalizeSecretInput(value);
  return normalized ? normalized : undefined;
}
