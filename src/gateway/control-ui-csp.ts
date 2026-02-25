/** Trusted origins that may embed the Control UI in an iframe (Playground). */
const TRUSTED_FRAME_ANCESTORS = [
  "https://app.hanzo.bot",
  "https://bot.hanzo.ai",
  "https://hanzo.app",
];

export function buildControlUiCspHeader(iamServerUrl?: string): string {
  // Control UI: allow embedding by trusted origins, block inline scripts,
  // keep styles permissive (UI uses inline style attributes in templates).
  // Allow Google Fonts for Geist font family.
  // When IAM mode is active, allow fetch to the IAM server for OIDC discovery
  // and token exchange (BrowserIamSdk talks to IAM directly via PKCE).
  let connectSrc = "'self' ws: wss:";
  if (iamServerUrl) {
    try {
      connectSrc += ` ${new URL(iamServerUrl).origin}`;
    } catch {
      // Invalid URL — skip.
    }
  }
  const frameAncestors = TRUSTED_FRAME_ANCESTORS.join(" ");
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors 'self' ${frameAncestors}`,
    "frame-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSrc}`,
  ].join("; ");
}
