export const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GENERATIVE_LANGUAGE_HOST = "generativelanguage.googleapis.com";
const GOOGLE_VERTEX_HOST = "aiplatform.googleapis.com";
const GOOGLE_VERTEX_REGION_HOST_SUFFIX = "-aiplatform.googleapis.com";
const GOOGLE_VERTEX_MULTI_REGION_HOSTS = new Set([
  "aiplatform.eu.rep.googleapis.com",
  "aiplatform.us.rep.googleapis.com",
]);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isGoogleVertexHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === GOOGLE_VERTEX_HOST ||
    normalized.endsWith(GOOGLE_VERTEX_REGION_HOST_SUFFIX) ||
    GOOGLE_VERTEX_MULTI_REGION_HOSTS.has(normalized)
  );
}

export function isGoogleVertexBaseUrl(baseUrl?: string | null): boolean {
  const raw = baseUrl?.trim();
  if (!raw) {
    return false;
  }
  const url = URL.parse(raw);
  return url !== null && isGoogleVertexHostname(url.hostname);
}

/** Match the actual Vertex transport route, including legacy `google-generative-ai` configs. */
export function usesGoogleVertexTransportRoute(params: {
  api?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
}): boolean {
  const api = params.api?.trim().toLowerCase();
  const provider = params.provider?.trim().toLowerCase();
  return (
    api === "google-vertex" ||
    (api === "google-generative-ai" &&
      (provider === "google-vertex" || isGoogleVertexBaseUrl(params.baseUrl)))
  );
}

export function normalizeGoogleApiBaseUrl(baseUrl?: string): string {
  const raw = trimTrailingSlashes(baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL);
  const url = URL.parse(raw);
  if (!url) {
    return raw;
  }
  url.hash = "";
  url.search = "";
  if (
    url.hostname.toLowerCase() === GOOGLE_GENERATIVE_LANGUAGE_HOST &&
    trimTrailingSlashes(url.pathname || "") === ""
  ) {
    url.pathname = "/v1beta";
  }
  return trimTrailingSlashes(url.toString());
}
