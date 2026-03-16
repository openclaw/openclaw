/**
 * Unified Gemini base URL normalization.
 *
 * Ensures:
 * 1. No trailing slashes
 * 2. Strips /openai suffix (proxy compat layer)
 * 3. Preserves existing API versions (/v1, /v1beta, /v2, etc.)
 * 4. Appends /v1beta ONLY when no version segment exists
 */

const API_VERSION_RE = /\/v\d+[a-z]*\d*$/;

/**
 * Normalize a Gemini base URL so that callers can directly append
 * `/${modelPath}:endpoint` without worrying about version duplication.
 *
 * The returned URL always ends with a version segment (e.g. `/v1beta`)
 * and never has a trailing slash.
 */
export function normalizeGeminiBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const raw = (baseUrl?.trim() || fallback).replace(/\/+$/, "");

  // Strip /openai suffix used by some proxies for OpenAI-compat layer
  const cleaned = raw.replace(/\/openai$/, "");

  // If there is already a version segment like /v1, /v1beta, /v2, keep it
  if (API_VERSION_RE.test(cleaned)) {
    return cleaned;
  }

  // No version segment → append default /v1beta
  return `${cleaned}/v1beta`;
}
