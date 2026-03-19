export function buildControlUiCspHeader(): string {
  // Control UI: block framing, block inline scripts, keep styles permissive
  // img-src restricted to 'self' + data: only (no blanket https:) to prevent
  // data exfiltration via attacker-controlled image URLs (audit finding M-2).
  // (UI uses a lot of inline style attributes in templates).
  // Keep Google Fonts origins explicit in CSP for deployments that load
  // external Google Fonts stylesheets/font files.
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:",
  ].join("; ");
}
