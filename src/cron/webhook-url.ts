import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";

function isAllowedWebhookProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

/**
 * Validate and normalize a webhook URL.
 *
 * Rejects non-http(s) protocols and hostnames that resolve to private,
 * loopback, link-local, or other special-use addresses (SSRF guard).
 * This is an early, static check on the literal hostname/IP before any
 * DNS resolution; the runtime fetch layer should still perform its own
 * DNS-pinned SSRF validation.
 */
export function normalizeHttpWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!isAllowedWebhookProtocol(parsed.protocol)) {
      return null;
    }
    // Block URLs targeting private/internal/special-use addresses.
    // parsed.hostname strips brackets from IPv6 literals automatically.
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
