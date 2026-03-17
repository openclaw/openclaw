import { isIpInCidr, normalizeIpAddress, isLoopbackIpAddress } from "../shared/net/ip.js";

/**
 * IP restriction configuration for gateway access control.
 */
export interface IpRestrictionConfig {
  /**
   * IP addresses/networks allowed to access the gateway.
   * Supports CIDR notation (e.g., "192.168.1.0/24") and individual IPs.
   * When set, only clients from these IPs/networks can connect.
   */
  ipAllowlist?: string[];

  /**
   * IP addresses/networks blocked from gateway access.
   * Supports CIDR notation and individual IPs.
   * Takes precedence over ipAllowlist.
   */
  ipBlocklist?: string[];
}

export type IpRestrictionValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Pre-compiled IP restriction checker for efficient runtime checks.
 */
export interface IpRestrictionChecker {
  (clientIp: string | undefined): boolean;
}

/**
 * Validates IP restriction configuration.
 * Returns warnings for potentially dangerous or unusual configurations.
 */
export function validateIpRestrictionConfig(
  config: IpRestrictionConfig,
): IpRestrictionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const allowlist = config.ipAllowlist ?? [];
  const blocklist = config.ipBlocklist ?? [];

  // Check for dangerous patterns in allowlist
  for (const entry of allowlist) {
    if (entry === "0.0.0.0/0" || entry === "::/0") {
      errors.push(
        `ipAllowlist contains ${entry} which allows all IPs - use empty allowlist instead`,
      );
    }
  }

  // Check for dangerous patterns in blocklist
  for (const entry of blocklist) {
    if (entry === "0.0.0.0/0" || entry === "::/0") {
      warnings.push(
        `ipBlocklist contains ${entry} which blocks all IPv${entry.includes(":") ? "6" : "4"} traffic`,
      );
    }
  }

  // Check for duplicate entries
  const allowlistSet = new Set(allowlist.map((e) => e.trim().toLowerCase()));
  const blocklistSet = new Set(blocklist.map((e) => e.trim().toLowerCase()));

  if (allowlistSet.size < allowlist.length) {
    warnings.push("ipAllowlist contains duplicate entries");
  }
  if (blocklistSet.size < blocklist.length) {
    warnings.push("ipBlocklist contains duplicate entries");
  }

  // Check for overlapping entries
  const overlap = [...allowlistSet].filter((ip) => blocklistSet.has(ip));
  if (overlap.length > 0) {
    warnings.push(
      `IPs appear in both allowlist and blocklist: ${overlap.join(", ")} (blocklist takes precedence)`,
    );
  }

  // Warn if allowlist is very restrictive
  if (
    allowlist.length > 0 &&
    !allowlist.some((ip) => isLoopbackIpAddress(ip) || ip === "127.0.0.1" || ip === "::1")
  ) {
    warnings.push(
      "ipAllowlist does not include loopback addresses - local connections may be blocked",
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return { ok: true, warnings };
}

/**
 * Checks if an IP address matches any entry in a list.
 * Supports both individual IPs and CIDR notation.
 */
function ipMatchesList(ip: string, list: string[]): boolean {
  const normalized = normalizeIpAddress(ip);
  if (!normalized) {
    return false;
  }

  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    // Direct IP match
    const normalizedEntry = normalizeIpAddress(trimmed);
    if (normalizedEntry && normalized === normalizedEntry) {
      return true;
    }

    // CIDR match
    if (trimmed.includes("/")) {
      try {
        if (isIpInCidr(normalized, trimmed)) {
          return true;
        }
      } catch {
        // Invalid CIDR entry, skip
      }
    }
  }

  return false;
}

/**
 * Checks if a client IP is allowed based on IP restriction configuration.
 *
 * Logic:
 * 1. If blocklist is set and IP matches → BLOCK (takes precedence)
 * 2. If allowlist is set → IP must match to be ALLOWED
 * 3. If neither is set → ALLOW all
 *
 * @param clientIp - The client IP address to check
 * @param config - IP restriction configuration
 * @returns true if the IP is allowed, false if blocked
 */
export function isIpAllowed(clientIp: string | undefined, config: IpRestrictionConfig): boolean {
  // No restrictions configured → allow all
  const allowlist = config.ipAllowlist ?? [];
  const blocklist = config.ipBlocklist ?? [];

  if (allowlist.length === 0 && blocklist.length === 0) {
    return true;
  }

  // Unable to determine client IP → fail closed (secure by default)
  if (!clientIp) {
    return false;
  }

  // Blocklist takes precedence
  if (blocklist.length > 0 && ipMatchesList(clientIp, blocklist)) {
    return false;
  }

  // If allowlist is set, IP must be in it
  if (allowlist.length > 0) {
    return ipMatchesList(clientIp, allowlist);
  }

  // No allowlist set, and not in blocklist → allow
  return true;
}

/**
 * Creates a pre-compiled IP restriction checker for efficient runtime checks.
 * Use this when you need to check multiple IPs with the same configuration.
 *
 * @param config - IP restriction configuration
 * @returns A function that checks if an IP is allowed
 */
export function createIpRestrictionChecker(config: IpRestrictionConfig): IpRestrictionChecker {
  const allowlist = (config.ipAllowlist ?? []).filter(Boolean);
  const blocklist = (config.ipBlocklist ?? []).filter(Boolean);

  // Pre-compile normalized lists for efficiency
  const normalizedAllowlist = allowlist.map((entry) => ({
    original: entry.trim(),
    normalized: normalizeIpAddress(entry.trim()),
    isCidr: entry.trim().includes("/"),
  }));

  const normalizedBlocklist = blocklist.map((entry) => ({
    original: entry.trim(),
    normalized: normalizeIpAddress(entry.trim()),
    isCidr: entry.trim().includes("/"),
  }));

  return (clientIp: string | undefined): boolean => {
    // No restrictions → allow all
    if (normalizedAllowlist.length === 0 && normalizedBlocklist.length === 0) {
      return true;
    }

    // Unable to determine IP → fail closed
    if (!clientIp) {
      return false;
    }

    const normalized = normalizeIpAddress(clientIp);
    if (!normalized) {
      return false;
    }

    // Check blocklist (takes precedence)
    for (const entry of normalizedBlocklist) {
      if (entry.normalized && normalized === entry.normalized) {
        return false;
      }
      if (entry.isCidr) {
        try {
          if (isIpInCidr(normalized, entry.original)) {
            return false;
          }
        } catch {
          // Skip invalid CIDR
        }
      }
    }

    // No allowlist → allow (not blocked)
    if (normalizedAllowlist.length === 0) {
      return true;
    }

    // Check allowlist
    for (const entry of normalizedAllowlist) {
      if (entry.normalized && normalized === entry.normalized) {
        return true;
      }
      if (entry.isCidr) {
        try {
          if (isIpInCidr(normalized, entry.original)) {
            return true;
          }
        } catch {
          // Skip invalid CIDR
        }
      }
    }

    // Not in allowlist → deny
    return false;
  };
}

/**
 * Formats IP restriction validation result as a human-readable message.
 */
export function formatIpRestrictionValidationMessage(
  result: IpRestrictionValidationResult,
): string {
  if (result.ok && result.warnings.length === 0) {
    return "IP restriction configuration is valid.";
  }

  const parts: string[] = [];

  if (!result.ok && result.errors.length > 0) {
    parts.push("ERRORS:");
    parts.push(...result.errors.map((e) => `  - ${e}`));
  }

  if (result.warnings.length > 0) {
    parts.push("WARNINGS:");
    parts.push(...result.warnings.map((w) => `  - ${w}`));
  }

  return parts.join("\n");
}
