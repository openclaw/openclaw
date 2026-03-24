import { createHash } from "node:crypto";

/**
 * Compute SHA-256 CSP hashes for inline `<script>` blocks in an HTML string.
 * Only scripts without a `src` attribute are considered inline.
 */
export function computeInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const openTag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (/\bsrc\s*=/i.test(openTag)) {
      continue;
    }
    const content = match[1];
    if (!content) {
      continue;
    }
    const hash = createHash("sha256").update(content, "utf8").digest("base64");
    hashes.push(`sha256-${hash}`);
  }
  return hashes;
}

export function buildControlUiCspHeader(opts?: { inlineScriptHashes?: string[] }): string {
  const hashes = opts?.inlineScriptHashes;
  const scriptSrc = hashes?.length
    ? `script-src 'self' ${hashes.map((h) => `'${h}'`).join(" ")}`
    : "script-src 'self'";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:",
  ].join("; ");
}
