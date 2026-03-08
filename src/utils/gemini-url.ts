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

  // Only append /v1beta for the default official base URL
  // For custom base URLs, use them as-is (preserve caller-specified API version)
  let baseUrlWithVersion: string;
  if (!params.baseUrl) {
    // No custom baseUrl provided - use default with /v1beta
    baseUrlWithVersion = `${rawBaseUrl}/v1beta`;
  } else {
    // Custom baseUrl provided - use it as-is, no modification
    // This preserves any custom API version path the caller may have specified
    baseUrlWithVersion = rawBaseUrl;
  }

  const modelPart = params.modelHasPrefix
    ? `models/${encodeURIComponent(params.modelId.replace(/^models\//, ""))}`
    : `models/${encodeURIComponent(params.modelId)}`;

  let url = `${baseUrlWithVersion}/${modelPart}${params.endpoint}`;

  if (params.apiKey) {
    url += `?key=${encodeURIComponent(params.apiKey)}`;
  }

  return url;
}
