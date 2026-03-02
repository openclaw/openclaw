function normalizeHostForConnectSrc(rawHost: string | undefined): string | null {
  if (!rawHost) {
    return null;
  }
  try {
    const hostname = new URL(`http://${rawHost}`).hostname.trim();
    return hostname || null;
  } catch {
    return null;
  }
}

export function buildControlUiCspHeader(requestHost?: string): string {
  // Control UI: block framing, block inline scripts, keep styles permissive
  // (UI uses a lot of inline style attributes in templates).
  // Keep Google Fonts origins explicit in CSP for deployments that load
  // external Google Fonts stylesheets/font files.
  const dynamicHost = normalizeHostForConnectSrc(requestHost);
  const connectSrc = [
    "'self'",
    "ws:",
    "wss:",
    "http://127.0.0.1:17493",
    "http://localhost:17493",
    "http://host.docker.internal:17493",
  ];
  if (dynamicHost) {
    connectSrc.push(`http://${dynamicHost}:17493`, `https://${dynamicHost}:17493`);
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSrc.join(" ")}`,
    "media-src 'self' blob:",
  ].join("; ");
}
