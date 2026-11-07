// Hostname normalization helpers keep SSRF and proxy policy comparisons stable
// across case, trailing dots, bracketed IPv6 literals, and IDN punycode.
import { domainToASCII } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Bracket IPv6 hosts when serializing a URL authority or host:port target. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeDnsName(value: string): string {
  // domainToASCII folds one Unicode name and its punycode spelling together.
  // A lookalike label stays a different ASCII name, so it cannot satisfy an
  // allowlist entry for the name it imitates.
  const ascii = domainToASCII(value);
  return ascii || value;
}

/** Normalize a hostname for policy comparisons. */
export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  if (normalized.includes(":")) {
    return normalized;
  }
  if (normalized.startsWith("*.")) {
    const suffix = normalizeDnsName(normalized.slice(2));
    return suffix ? `*.${suffix}` : normalized;
  }
  return normalizeDnsName(normalized);
}
