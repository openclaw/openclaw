import os from "node:os";
import { isIpInCidr } from "@openclaw/net-policy/ip";
import { pickMatchingExternalInterfaceAddress } from "./network-interfaces.js";

const TAILNET_IPV4_CIDR = "100.64.0.0/10";
// Stable across tailnets; nodes get per-device suffixes.
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";

/** Returns true when an address is inside Tailscale's CGNAT IPv4 range. */
export function isTailnetIPv4(address: string): boolean {
  // Tailscale IPv4 range: 100.64.0.0/10
  // https://tailscale.com/kb/1015/100.x-addresses
  return isIpInCidr(address, TAILNET_IPV4_CIDR);
}

/** Returns the first discovered Tailscale IPv4 address, if any. */
export function pickPrimaryTailnetIPv4(): string | undefined {
  return pickMatchingExternalInterfaceAddress(os.networkInterfaces(), {
    family: "IPv4",
    matches: isTailnetIPv4,
  });
}

/** Returns the first discovered Tailscale IPv6 address, if any. */
export function pickPrimaryTailnetIPv6(): string | undefined {
  return pickMatchingExternalInterfaceAddress(os.networkInterfaces(), {
    family: "IPv6",
    matches: (address) => isIpInCidr(address, TAILNET_IPV6_CIDR),
  });
}
