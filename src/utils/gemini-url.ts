/**
 * Unified Gemini URL builder to avoid /v1beta/v1beta duplication issues.
 * This ensures consistent URL construction across all Gemini-related modules.
 */

/**
 * Builds a Gemini API URL with proper version handling.
 *
 * @param params.baseUrl - Optional custom base URL (may or may not include /v1beta)
 * @param params.modelId - The model ID to use (without "models/" prefix)
 * @param params.endpoint - The endpoint suffix (e.g., ":generateContent", ":embedContent")
 * @param params.apiKey - Optional API key to append as query parameter
 * @param params.modelHasPrefix - Set to true if modelId already includes "models/" prefix
 * @returns The fully constructed URL
 */
export function buildGeminiUrl(params: {
  baseUrl?: string;
  modelId: string;
  endpoint: string;
  apiKey?: string;
  modelHasPrefix?: boolean;
}): string {
  const defaultBaseUrl = "https://generativelanguage.googleapis.com";
  const rawBaseUrl = (params.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");

  // Check if baseUrl already includes /v1beta (at end or with trailing slash)
  const hasV1Beta = /\/v1beta(\/|$)/.test(rawBaseUrl);
  const baseUrlWithVersion = hasV1Beta ? rawBaseUrl : `${rawBaseUrl}/v1beta`;

  const modelPart = params.modelHasPrefix
    ? `models/${encodeURIComponent(params.modelId.replace(/^models\//, ""))}`
    : `models/${encodeURIComponent(params.modelId)}`;

  let url = `${baseUrlWithVersion}/${modelPart}${params.endpoint}`;

  if (params.apiKey) {
    url += `?key=${encodeURIComponent(params.apiKey)}`;
  }

  return url;
}
