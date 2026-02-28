export function buildControlUiCspHeader(): string {
  // Control UI: block framing, block inline scripts, keep styles permissive
  // (UI uses a lot of inline style attributes in templates).
  // Control UI imports Google Fonts stylesheets in base.css, so allow the
  // stylesheet origin and corresponding font file CDN explicitly.
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:",
  ].join("; ");
}
