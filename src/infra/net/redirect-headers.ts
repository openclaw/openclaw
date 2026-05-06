import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

const CROSS_ORIGIN_REDIRECT_SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
]);

export function retainSafeHeadersForCrossOriginRedirect(
  headers?: HeadersInit | Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  const incoming = new Headers(sanitizeHeadersInit(headers));
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of incoming.entries()) {
    if (CROSS_ORIGIN_REDIRECT_SAFE_HEADERS.has(normalizeLowercaseStringOrEmpty(key))) {
      safeHeaders[key] = value;
    }
  }
  return safeHeaders;
}

/**
 * Strips non-string keys (Symbols) from HeadersInit to prevent
 * "ByteString" conversion crashes on Node.js 22.
 */
export function sanitizeHeadersInit(init: HeadersInit | undefined): HeadersInit | undefined {
  if (!init || typeof init !== "object" || Array.isArray(init) || init instanceof Headers) {
    return init;
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(init)) {
    clean[key] = value;
  }
  return clean;
}
