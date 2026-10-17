// Hostname normalization helpers keep SSRF and proxy policy comparisons stable
// across case, trailing dots, and bracketed IPv6 literals.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Normalize a hostname for policy comparisons. */
export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/** Bracket an IPv6 literal for a URL authority or `host:port` target. */
export function formatUrlHost(host: string): string {
  return host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
}
