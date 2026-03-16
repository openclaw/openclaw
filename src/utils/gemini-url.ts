/**
 * Unified Gemini base URL normalization.
 *
 * Ensures:
 * 1. No trailing slashes
 * 2. Strips /openai and /openai/... suffix (proxy compat layer)
 * 3. Preserves base URLs verbatim (custom proxies)
 *
 * Callers that need a version segment (e.g. /v1beta) should use
 * {@link ensureGeminiVersionSegment} on the result.
 */

/** Matches a terminal API version segment like /v1, /v1beta, /v2alpha3. */
export const API_VERSION_RE = /\/v\d+[a-z]*\d*$/;

/**
 * Normalize a Gemini base URL: trim, strip trailing slashes, strip /openai
 * compat suffix. Does NOT append a version segment — use
 * {@link ensureGeminiVersionSegment} when the caller requires one.
 */
export function normalizeGeminiBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const raw = (baseUrl?.trim() || fallback).replace(/\/+$/, "");

  // Strip /openai or /openai/... suffix used by some proxies for OpenAI-compat layer
  return raw.replace(/\/openai(\/.*)?$/, "");
}

/**
 * If the URL does not already end with an API version segment,
 * append the given default version (defaults to `/v1beta`).
 */
export function ensureGeminiVersionSegment(url: string, version = "/v1beta"): string {
  if (API_VERSION_RE.test(url)) {
    return url;
  }
  return `${url}${version}`;
}
