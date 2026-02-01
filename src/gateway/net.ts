import net from "node:net";
import os from "node:os";

import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";

/**
 * Check if an IPv4 address is in a private range (RFC 1918 + loopback + link-local).
 *
 * Private ranges:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 127.0.0.0/8 (loopback)
 * - 169.254.0.0/16 (link-local)
 */
export function isPrivateIPv4(ip: string): boolean {
  // 10.0.0.0/8
  if (ip.startsWith("10.")) return true;
  // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  if (ip.startsWith("172.")) {
    const parts = ip.split(".");
    if (parts.length >= 2) {
      const second = parseInt(parts[1], 10);
      if (!Number.isNaN(second) && second >= 16 && second <= 31) return true;
    }
  }
  // 192.168.0.0/16
  if (ip.startsWith("192.168.")) return true;
  // 127.0.0.0/8 (loopback)
  if (ip.startsWith("127.")) return true;
  // 169.254.0.0/16 (link-local)
  if (ip.startsWith("169.254.")) return true;
  return false;
}

/**
 * Check if an IPv6 address is in a private/local range.
 *
 * Private ranges:
 * - fc00::/7 (unique local addresses - fc00:: and fd00::)
 * - fe80::/10 (link-local)
 * - ::1 (loopback)
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // fc00::/7 (unique local) - starts with fc or fd
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 (link-local) - first hextet in [0xfe80, 0xfebf]
  {
    const colonIndex = lower.indexOf(":");
    const firstHextetStr = colonIndex === -1 ? lower : lower.slice(0, colonIndex);
    const firstHextet = parseInt(firstHextetStr, 16);
    if (!Number.isNaN(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) {
      return true;
    }
  }
  // ::1 (loopback)
  if (lower === "::1") return true;
  // ::ffff: mapped IPv4 - check the IPv4 portion
  if (lower.startsWith("::ffff:")) {
    const ipv4Part = lower.slice("::ffff:".length);
    return isPrivateIPv4(ipv4Part);
  }
  return false;
}

/**
 * Check if an IP address (v4 or v6) is private/local.
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  const version = net.isIP(trimmed);
  if (version === 6) return isPrivateIPv6(trimmed);
  if (version === 4) return isPrivateIPv4(trimmed);
  // Not a valid IP address string; treat as not private.
  return false;
}

/**
 * Get all public (non-private) IP addresses from network interfaces.
 * Useful for warning users when they bind to 0.0.0.0 on a machine with public IPs.
 */
export function getPublicIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const publicIPs: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.internal) continue;
      if (!isPrivateIP(iface.address)) {
        publicIPs.push(iface.address);
      }
    }
  }

  return publicIPs;
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

function normalizeIPv4MappedAddress(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

function normalizeIp(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) return undefined;
  return normalizeIPv4MappedAddress(trimmed.toLowerCase());
}

function stripOptionalPort(ip: string): string {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end !== -1) return ip.slice(1, end);
  }
  if (net.isIP(ip)) return ip;
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) return candidate;
  }
  return ip;
}

export function parseForwardedForClientIp(forwardedFor?: string): string | undefined {
  const raw = forwardedFor?.split(",")[0]?.trim();
  if (!raw) return undefined;
  return normalizeIp(stripOptionalPort(raw));
}

function parseRealIp(realIp?: string): string | undefined {
  const raw = realIp?.trim();
  if (!raw) return undefined;
  return normalizeIp(stripOptionalPort(raw));
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) return false;
  return trustedProxies.some((proxy) => normalizeIp(proxy) === normalized);
}

export function resolveGatewayClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
}): string | undefined {
  const remote = normalizeIp(params.remoteAddr);
  if (!remote) return undefined;
  if (!isTrustedProxyAddress(remote, params.trustedProxies)) return remote;
  return parseForwardedForClientIp(params.forwardedFor) ?? parseRealIp(params.realIp) ?? remote;
}

export function isLocalGatewayAddress(ip: string | undefined): boolean {
  if (isLoopbackAddress(ip)) return true;
  if (!ip) return false;
  const normalized = normalizeIPv4MappedAddress(ip.trim().toLowerCase());
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  if (tailnetIPv4 && normalized === tailnetIPv4.toLowerCase()) return true;
  const tailnetIPv6 = pickPrimaryTailnetIPv6();
  if (tailnetIPv6 && ip.trim().toLowerCase() === tailnetIPv6.toLowerCase()) return true;
  return false;
}

/**
 * Resolves gateway bind host with fallback strategy.
 *
 * Modes:
 * - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
 * - lan: always 0.0.0.0 (no fallback)
 * - tailnet: Tailnet IPv4 if available, else loopback
 * - auto: Loopback if available, else 0.0.0.0
 * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
 *
 * @returns The bind address to use (never null)
 */
export async function resolveGatewayBindHost(
  bind: import("../config/config.js").GatewayBindMode | undefined,
  customHost?: string,
): Promise<string> {
  const mode = bind ?? "loopback";

  if (mode === "loopback") {
    // 127.0.0.1 rarely fails, but handle gracefully
    if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
    return "0.0.0.0"; // extreme fallback
  }

  if (mode === "tailnet") {
    const tailnetIP = pickPrimaryTailnetIPv4();
    if (tailnetIP && (await canBindToHost(tailnetIP))) return tailnetIP;
    if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
    return "0.0.0.0";
  }

  if (mode === "lan") {
    return "0.0.0.0";
  }

  if (mode === "custom") {
    const host = customHost?.trim();
    if (!host) return "0.0.0.0"; // invalid config → fall back to all

    if (isValidIPv4(host) && (await canBindToHost(host))) return host;
    // Custom IP failed → fall back to LAN
    return "0.0.0.0";
  }

  if (mode === "auto") {
    if (await canBindToHost("127.0.0.1")) return "127.0.0.1";
    return "0.0.0.0";
  }

  return "0.0.0.0";
}

/**
 * Test if we can bind to a specific host address.
 * Creates a temporary server, attempts to bind, then closes it.
 *
 * @param host - The host address to test
 * @returns True if we can successfully bind to this address
 */
export async function canBindToHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = net.createServer();
    testServer.once("error", () => {
      resolve(false);
    });
    testServer.once("listening", () => {
      testServer.close();
      resolve(true);
    });
    // Use port 0 to let OS pick an available port for testing
    testServer.listen(0, host);
  });
}

export async function resolveGatewayListenHosts(
  bindHost: string,
  opts?: { canBindToHost?: (host: string) => Promise<boolean> },
): Promise<string[]> {
  if (bindHost !== "127.0.0.1") return [bindHost];
  const canBind = opts?.canBindToHost ?? canBindToHost;
  if (await canBind("::1")) return [bindHost, "::1"];
  return [bindHost];
}

/**
 * Validate if a string is a valid IPv4 address.
 *
 * @param host - The string to validate
 * @returns True if valid IPv4 format
 */
function isValidIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const n = parseInt(part, 10);
    return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
  });
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}
