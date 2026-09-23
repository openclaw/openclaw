// Discovers local Tailscale tailnet addresses.
import { isIpInCidr } from "@openclaw/net-policy/ip";
import {
  pickMatchingExternalInterfaceAddress,
  readNetworkInterfaces,
} from "./network-interfaces.js";

const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";

/** Returns true when an address is inside Tailscale's CGNAT IPv4 range. */
export function isTailnetIPv4(address: string): boolean {
  // Tailscale IPv4 range: 100.64.0.0/10
  // https://tailscale.com/kb/1015/100.x-addresses
  return isIpInCidr(address, TAILNET_IPV4_CIDR);
}

function isTailnetIPv6(address: string): boolean {
  // Tailscale IPv6 ULA prefix: fd7a:115c:a1e0::/48
  // (stable across tailnets; nodes get per-device suffixes)
  return isIpInCidr(address, TAILNET_IPV6_CIDR);
}

/** Returns the first discovered Tailscale IPv4 address, if any. */
export function pickPrimaryTailnetIPv4(): string | undefined {
  return pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
    family: "IPv4",
    matches: isTailnetIPv4,
  });
}

/** Returns the first discovered Tailscale IPv6 address, if any. */
export function pickPrimaryTailnetIPv6(): string | undefined {
  return pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
    family: "IPv6",
    matches: isTailnetIPv6,
  });
}
