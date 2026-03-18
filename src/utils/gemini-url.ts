/**
 * Unified Gemini base URL normalization.
 *
 * Ensures:
 * 1. No trailing slashes
 * 2. Strips /openai suffix (proxy compat layer)
 * 3. Preserves base URLs verbatim (custom proxies).
 */

/**
 * Normalize a Gemini base URL so that callers can directly append
 * `/${modelPath}:endpoint` without worrying about trailing slashes or OpenAI polyfills.
 */
export function normalizeGeminiBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const raw = (baseUrl?.trim() || fallback).replace(/\/+$/, "");

  // Strip /openai suffix used by some proxies for OpenAI-compat layer
  return raw.replace(/\/openai$/, "");
}
