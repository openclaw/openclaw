/**
 * Unicode-aware word boundary helpers.
 *
 * JavaScript's built-in `\b` word boundary only recognises ASCII word characters
 * (`[a-zA-Z0-9_]`). Characters like å, ä, ö, é, ñ, ü — and all non-Latin scripts —
 * are treated as non-word characters, which breaks mention detection, token matching,
 * and text processing for non-English languages.
 *
 * These helpers use Unicode property escapes (`\p{L}`, `\p{N}`) so that **any**
 * letter or digit in any script is considered a "word character".
 *
 * All RegExp instances built with these helpers **must** use the `u` flag.
 */

/**
 * Zero-width assertion matching the start of a word (Unicode-aware).
 * Matches at the start of the string or after a character that is NOT a Unicode
 * letter, digit, or underscore.
 */
export const UNICODE_WORD_START = String.raw`(?:(?<=^)|(?<=(?:[^\p{L}\p{N}_])))`;

/**
 * Zero-width assertion matching the end of a word (Unicode-aware).
 * Matches at the end of the string or before a character that is NOT a Unicode
 * letter, digit, or underscore.
 */
export const UNICODE_WORD_END = String.raw`(?:(?=$)|(?=(?:[^\p{L}\p{N}_])))`;

/** Character class matching a single non-word character (Unicode-aware). */
export const UNICODE_NON_WORD = String.raw`[^\p{L}\p{N}_]`;

/**
 * Wrap a pattern string with Unicode-aware word boundaries.
 *
 * Usage:
 * ```ts
 * const re = new RegExp(wrapWordBoundary(escapeRegExp("Pück")), "iu");
 * re.test("Hej Pück!"); // true
 * ```
 */
export function wrapWordBoundary(pattern: string): string {
  return `${UNICODE_WORD_START}${pattern}${UNICODE_WORD_END}`;
}
