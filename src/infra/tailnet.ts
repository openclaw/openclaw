import { execSync } from "node:child_process";
import os from "node:os";
import { isIpInCidr } from "../shared/net/ip.js";

export type TailnetAddresses = {
  ipv4: string[];
  ipv6: string[];
};

const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";

/**
 * Checks if an address is in the official Tailscale range.
 */
export function isTailnetIPv4(address: string): boolean {
  // Check official range first
  if (isIpInCidr(address, TAILNET_IPV4_CIDR)) return true;

  // Check for custom range override via env
  const customCidr = process.env.OPENCLAW_TAILNET_IPV4_CIDR;
  if (customCidr && isIpInCidr(address, customCidr)) return true;

  return false;
}

function isTailnetIPv6(address: string): boolean {
  if (isIpInCidr(address, TAILNET_IPV6_CIDR)) return true;
  const customCidr = process.env.OPENCLAW_TAILNET_IPV6_CIDR;
  if (customCidr && isIpInCidr(address, customCidr)) return true;
  return false;
}

/**
 * Tries to find the Tailscale binary across common locations.
 */
function findTailscaleBin(): string | undefined {
  const paths = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ];

  for (const p of paths) {
    try {
      // Use command -v for shell lookup if it's just a name
      const cmd = p.startsWith("/") ? p : `command -v ${p}`;
      const resolved = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (resolved) return resolved;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Attempts to get IPs directly from Tailscale/Headscale CLI if possible.
 */
function getAddressesFromCli(): TailnetAddresses | undefined {
  const bin = findTailscaleBin();
  if (!bin) return undefined;

  let ipv4: string[] = [];
  let ipv6: string[] = [];

  try {
    // tailscale ip -4 is fast and returns just the addresses
    ipv4 = execSync(`${bin} ip -4`, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    // IPv4 failed, but we might still have IPv6
  }

  try {
    // tailscale ip -6 is fast and returns just the addresses
    ipv6 = execSync(`${bin} ip -6`, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    // IPv6 failed, but we might still have IPv4
  }

  if (ipv4.length > 0 || ipv6.length > 0) {
    return { ipv4, ipv6 };
  }

  return undefined;
}

export function listTailnetAddresses(): TailnetAddresses {
  // 1. Try CLI first (supports Headscale/custom ranges natively)
  const fromCli = getAddressesFromCli();
  if (fromCli) {
    return fromCli;
  }

  // 2. Fallback to scanning interfaces with known/custom ranges
  const ipv4: string[] = [];
  const ipv6: string[] = [];

  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const e of entries) {
      if (!e || e.internal) continue;
      const address = e.address?.trim();
      if (!address) continue;

      if (isTailnetIPv4(address)) ipv4.push(address);
      if (isTailnetIPv6(address)) ipv6.push(address);
    }
  }

  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function pickPrimaryTailnetIPv4(): string | undefined {
  return listTailnetAddresses().ipv4[0];
}

export function pickPrimaryTailnetIPv6(): string | undefined {
  return listTailnetAddresses().ipv6[0];
}
