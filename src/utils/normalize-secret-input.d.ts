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
export declare function normalizeSecretInput(value: unknown): string;
export declare function normalizeOptionalSecretInput(value: unknown): string | undefined;
