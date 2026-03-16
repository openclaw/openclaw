import type { IncomingMessage } from "node:http";

/**
 * Derive the host used for CSP WebSocket origins from the incoming request.
 * Supports reverse-proxy setups via X-Forwarded-Host, and strips the port so
 * the wildcard port syntax (`ws://host:*`) works correctly.
 */
function deriveWsHost(req?: IncomingMessage): string {
  const raw =
    req?.headers?.["x-forwarded-host"]?.toString().split(",")[0]?.trim() ??
    req?.headers?.host ??
    "localhost";
  // Strip port (including IPv6 bracket form like [::1]:1234)
  return raw.replace(/:\d+$/, "");
}

export function buildControlUiCspHeader(req?: IncomingMessage): string {
  // Control UI: block framing, block inline scripts, keep styles permissive
  // (UI uses a lot of inline style attributes in templates).
  // Keep Google Fonts origins explicit in CSP for deployments that load
  // external Google Fonts stylesheets/font files.
  const wsHost = deriveWsHost(req);
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src 'self' ws://${wsHost}:* wss://${wsHost}:*`,
  ].join("; ");
}
