/**
 * IP-based access control for the gateway.
 *
 * Supports allowlist and blocklist with CIDR notation. Blocklist takes priority
 * over allowlist. Loopback addresses are always permitted regardless of list
 * configuration.
 */

import { isIpInCidr } from "../shared/net/ip.js";
import { isLoopbackAddress } from "./net.js";

export type IpAccessControlConfig = {
  /** CIDR entries or exact IPs to allow. When non-empty, only listed IPs pass. */
  allowlist?: string[];
  /** CIDR entries or exact IPs to deny. Checked before the allowlist. */
  blocklist?: string[];
};

export type IpAccessCheckResult = {
  allowed: boolean;
  reason?: "loopback" | "blocklist" | "allowlist" | "allowlist_miss";
};

/**
 * Check whether `clientIp` is permitted by the given allowlist/blocklist rules.
 *
 * Evaluation order:
 * 1. Loopback addresses are always allowed.
 * 2. If `clientIp` matches any blocklist entry → denied.
 * 3. If an allowlist is configured and non-empty, `clientIp` must match at least one entry.
 * 4. Otherwise → allowed.
 */
export function checkIpAccess(params: {
  clientIp: string | undefined;
  allowlist?: string[];
  blocklist?: string[];
}): IpAccessCheckResult {
  const { clientIp, allowlist, blocklist } = params;

  if (!clientIp) {
    // No IP available — fail closed when lists are configured.
    if ((blocklist && blocklist.length > 0) || (allowlist && allowlist.length > 0)) {
      return { allowed: false, reason: "allowlist_miss" };
    }
    return { allowed: true };
  }

  // Loopback always passes.
  if (isLoopbackAddress(clientIp)) {
    return { allowed: true, reason: "loopback" };
  }

  // Blocklist check (deny takes priority).
  if (blocklist && blocklist.length > 0) {
    for (const entry of blocklist) {
      if (isIpInCidr(clientIp, entry)) {
        return { allowed: false, reason: "blocklist" };
      }
    }
  }

  // Allowlist check (when configured, IP must match at least one entry).
  if (allowlist && allowlist.length > 0) {
    for (const entry of allowlist) {
      if (isIpInCidr(clientIp, entry)) {
        return { allowed: true, reason: "allowlist" };
      }
    }
    return { allowed: false, reason: "allowlist_miss" };
  }

  return { allowed: true };
}
