import { normalizeHostname } from "./hostname.js";
import { SsrFBlockedError } from "./ssrf.js";

/**
 * Error thrown when a domain is blocked by the DNS blocklist.
 * Extends SsrFBlockedError so callers can distinguish blocklist blocks
 * from general SSRF blocks while still catching the common base class.
 */
export class DnsBlocklistError extends SsrFBlockedError {
  constructor(domain: string) {
    super(`Domain blocked by DNS blocklist: ${domain}`);
    this.name = "DnsBlocklistError";
  }
}

/** Test-safe starter list using reserved TLDs (.test, .bad). */
export const DEFAULT_BLOCKED_DOMAINS: readonly string[] = [
  "malware.test",
  "phishing.test",
  "tracker.test",
  "adware.test",
  "cryptominer.test",
  "spyware.test",
  "blocked.bad",
] as const;

/** Module-level blocklist Set, initialized from defaults. */
let blockedDomains = new Set<string>(DEFAULT_BLOCKED_DOMAINS);

/**
 * Check whether a hostname (or any of its parent domains) is blocked.
 * Performs suffix-based matching: if "malware.test" is blocked,
 * "sub.malware.test" is also blocked.
 */
export function isDomainBlocked(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }

  // Exact match first.
  if (blockedDomains.has(normalized)) {
    return true;
  }

  // Suffix walk: strip one label at a time from the left.
  let rest = normalized;
  let dot = rest.indexOf(".");
  while (dot !== -1) {
    rest = rest.slice(dot + 1);
    if (blockedDomains.has(rest)) {
      return true;
    }
    dot = rest.indexOf(".");
  }

  return false;
}

/** Atomically replace the entire blocklist. */
export function setBlockedDomains(domains: string[]): void {
  blockedDomains = new Set(domains.map((d) => normalizeHostname(d)).filter(Boolean));
}

/** Add a single domain to the blocklist. */
export function addBlockedDomain(domain: string): void {
  const normalized = normalizeHostname(domain);
  if (normalized) {
    blockedDomains.add(normalized);
  }
}

/** Remove a single domain from the blocklist. */
export function removeBlockedDomain(domain: string): void {
  const normalized = normalizeHostname(domain);
  if (normalized) {
    blockedDomains.delete(normalized);
  }
}
