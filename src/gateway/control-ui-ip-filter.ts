// Authored by: cc (Claude Code) | 2026-03-23
import type { GatewayBindMode } from "../config/types.gateway.js";
import { isIpInCidr } from "../shared/net/ip.js";
import { isLoopbackAddress } from "./net.js";

/**
 * Determines whether a client IP is permitted to access the Control UI.
 *
 * Rules (evaluated in order):
 * 1. Loopback (127.0.0.1, ::1) always allowed — local app/CLI must not be locked out.
 * 2. If `allowedNetworks` is set and non-empty, check the CIDR list; fail closed if ip is unknown.
 * 3. If `allowedNetworks` is absent and bind mode is `lan` or `custom` (i.e. the gateway
 *    listens on a non-loopback interface), deny by default — opt-in required.
 * 4. All other bind modes (loopback/tailnet/auto/undefined): pass through — the bind
 *    address itself constrains reachability.
 */
export function isControlUiIpAllowed(
  ip: string | undefined,
  opts: { allowedNetworks?: string[]; bindMode?: GatewayBindMode },
): boolean {
  // Rule 1: loopback always permitted
  if (isLoopbackAddress(ip)) {
    return true;
  }

  const { allowedNetworks, bindMode } = opts;

  // Rule 2: explicit allowlist — fail closed when ip is unknown
  if (allowedNetworks && allowedNetworks.length > 0) {
    return ip !== undefined && allowedNetworks.some((cidr) => isIpInCidr(ip, cidr));
  }

  // Rule 3: secure default for bind modes that open the gateway to non-loopback interfaces
  if (bindMode === "lan" || bindMode === "custom") {
    return false;
  }

  // Rule 4: loopback/tailnet/auto/undefined — bind address limits access, no extra check needed
  return true;
}
