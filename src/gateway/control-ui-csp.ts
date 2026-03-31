import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const SCRIPT_ATTRIBUTE_NAME_RE = /\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

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
    if (hasScriptSrcAttribute(openTag)) {
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

function hasScriptSrcAttribute(openTag: string): boolean {
  return Array.from(openTag.matchAll(SCRIPT_ATTRIBUTE_NAME_RE)).some(
    (match) => normalizeLowercaseStringOrEmpty(match[1]) === "src",
  );
}

export function buildControlUiCspHeader(opts?: {
  inlineScriptHashes?: string[];
  extraConnectSrc?: string[];
}): string {
  const hashes = opts?.inlineScriptHashes;
  const scriptSrc = hashes?.length
    ? `script-src 'self' ${hashes.map((h) => `'${h}'`).join(" ")}`
    : "script-src 'self'";
  // 'self' covers same-origin HTTP/WS requests.  The Control UI also
  // supports user-configured cross-origin gateway URLs (gatewayUrl query
  // param), so we additionally allow wss: to permit secure WebSocket
  // connections to remote gateways without opening the blanket ws: scheme.
  const extraSrc = opts?.extraConnectSrc?.length ? ` ${opts.extraConnectSrc.join(" ")}` : "";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "worker-src 'self'",
    `connect-src 'self' wss:${extraSrc}`,
  ].join("; ");
}
