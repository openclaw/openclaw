import { resolveProviderEndpoint } from "../agents/provider-attribution.js";

export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    if (
      resolveProviderEndpoint(url.toString()).endpointClass === "google-generative-ai" &&
      trimTrailingSlashes(url.pathname || "") === ""
    ) {
      url.pathname = "/v1beta";
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    if (resolveProviderEndpoint(raw).endpointClass === "google-generative-ai") {
      return DEFAULT_GOOGLE_API_BASE_URL;
    }
    return raw;
  }
}
