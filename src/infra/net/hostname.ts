// Hostname normalization helpers keep SSRF and proxy policy comparisons stable
// across case, trailing dots, bracketed IPv6 literals, and IDN punycode.
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Bracket IPv6 hosts when serializing a URL authority or host:port target. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeDnsName(value: string): string {
  // The URL parser also rewrites numeric hosts and drops path suffixes.
  // Keep those inputs intact for the callers that validate host syntax.
  if (/^\p{ASCII}*$/u.test(value) || !/^(?:[a-z\d._-]|[^\p{ASCII}])+$/u.test(value)) {
    return value;
  }
  const ascii = domainToASCII(value);
  return ascii && !isIP(ascii) ? ascii : value;
}

/** Normalize a hostname for policy comparisons. */
export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  if (normalized.startsWith("*.")) {
    return `*.${normalizeDnsName(normalized.slice(2))}`;
  }
  return normalizeDnsName(normalized);
}
