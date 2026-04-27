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
export declare const CHARS_PER_TOKEN_ESTIMATE = 4;
/**
 * Return an adjusted character length that accounts for non-Latin (CJK, etc.)
 * characters.  Each non-Latin character is counted as
 * {@link CHARS_PER_TOKEN_ESTIMATE} chars so that the downstream
 * `chars / CHARS_PER_TOKEN_ESTIMATE` token estimate remains accurate.
 *
 * For pure ASCII/Latin text the return value equals `text.length` (no change).
 */
export declare function estimateStringChars(text: string): number;
/**
 * Estimate the number of tokens from a raw character count.
 *
 * For a more accurate estimate when the source text is available, prefer
 * `estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE` instead.
 */
export declare function estimateTokensFromChars(chars: number): number;
