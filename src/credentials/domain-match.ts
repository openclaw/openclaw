/**
 * Domain and selector matching for the Credential Firewall.
 *
 * Pinned domains restrict where credentials can be injected.
 * Supports exact match, wildcard subdomains (*.example.com),
 * and shorthand (.example.com).
 */

export interface DomainCheckResult {
  allowed: boolean;
  hostname: string;
  matchedDomain?: string;
}

export function isDomainAllowed(currentUrl: string, pinnedDomains: string[]): DomainCheckResult {
  let hostname: string;
  try {
    hostname = new URL(currentUrl).hostname.toLowerCase();
  } catch {
    return { allowed: false, hostname: currentUrl };
  }

  for (const pinned of pinnedDomains) {
    const pattern = pinned.toLowerCase().trim();
    if (!pattern) {
      continue;
    }

    if (hostname === pattern) {
      return { allowed: true, hostname, matchedDomain: pattern };
    }

    // *.example.com or .example.com → match any subdomain
    const wildcard = pattern.startsWith("*.")
      ? pattern.slice(2)
      : pattern.startsWith(".")
        ? pattern.slice(1)
        : null;

    if (wildcard && (hostname === wildcard || hostname.endsWith(`.${wildcard}`))) {
      return { allowed: true, hostname, matchedDomain: pattern };
    }
  }

  return { allowed: false, hostname };
}

export function isSelectorAllowed(selector: string, allowedSelectors?: string[]): boolean {
  if (!allowedSelectors || allowedSelectors.length === 0) {
    return true;
  }
  return allowedSelectors.some((allowed) => selector === allowed);
}
