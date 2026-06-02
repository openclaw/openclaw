import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Normalize hostnames for policy checks: lowercase, remove DNS root dots, unbracket IPv6. */
export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}
