/**
 * HTTP security response headers middleware.
 *
 * Applies defense-in-depth headers to every HTTP response:
 * - Strict-Transport-Security (HSTS) when TLS is active
 * - Cache-Control: no-store on API and auth endpoints
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY (backup for CSP frame-ancestors)
 * - Referrer-Policy: strict-origin-when-cross-origin
 */

import type { ServerResponse } from "node:http";

export interface SecurityHeadersConfig {
  /** Whether the server is using TLS (enables HSTS). */
  tlsEnabled?: boolean;
}

/** Paths that should receive no-cache headers to prevent credential leakage. */
const NO_CACHE_PATH_PREFIXES = ["/api/", "/hooks/", "/v1/"];

/**
 * Apply security headers to an HTTP response.
 *
 * Should be called early in the request lifecycle, before any body is sent.
 */
export function applySecurityHeaders(
  res: ServerResponse,
  requestPath: string,
  config?: SecurityHeadersConfig,
): void {
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Clickjacking protection (backup for CSP frame-ancestors: 'none')
  res.setHeader("X-Frame-Options", "DENY");

  // Limit referrer information leakage
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // HSTS – only when TLS is enabled to avoid breaking plain-HTTP setups
  if (config?.tlsEnabled) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Prevent caching of API responses and auth-related endpoints
  const shouldNoCache = NO_CACHE_PATH_PREFIXES.some((prefix) => requestPath.startsWith(prefix));
  if (shouldNoCache) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
}
