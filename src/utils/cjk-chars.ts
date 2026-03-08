/**
 * CJK-aware character counting for accurate token estimation.
 *
 * Most LLM tokenizers encode CJK (Chinese, Japanese, Korean) characters as
 * roughly 1 token per character, whereas Latin/ASCII text averages ~1 token
 * per 4 characters.  When the codebase estimates tokens as `chars / 4`, CJK
 * content is underestimated by 2–4×.
 *
 * This module provides a shared helper that inflates the character count of
 * CJK text so that the standard `chars / 4` formula yields an accurate
 * token estimate for any script.
 */

/**
 * Default characters-per-token ratio used throughout the codebase.
 * Latin text ≈ 4 chars/token; CJK ≈ 1 char/token.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Matches CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
 * Ideographs, Hangul Syllables, Hiragana, Katakana, and other non-Latin
 * scripts that typically use ~1 token per character.
 */
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;

/**
 * Return an adjusted character length that accounts for non-Latin (CJK, etc.)
 * characters.  Each non-Latin character is counted as
 * {@link CHARS_PER_TOKEN_ESTIMATE} chars so that the downstream
 * `chars / CHARS_PER_TOKEN_ESTIMATE` token estimate remains accurate.
 *
 * For pure ASCII/Latin text the return value equals `text.length` (no change).
 */
export function estimateStringChars(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  // Non-Latin chars already contribute 1 to text.length, so add the extra weight.
  return text.length + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

/**
 * Estimate the number of tokens from a raw character count.
 *
 * For a more accurate estimate when the source text is available, prefer
 * `estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE` instead.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
