import net from "node:net";
import os from "node:os";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import {
  isCanonicalDottedDecimalIPv4,
  isIpInCidr,
  isLoopbackIpAddress,
  isPrivateOrLoopbackIpAddress,
  normalizeIpAddress,
} from "../shared/net/ip.js";

/**
 * Pick the primary non-internal IPv4 address (LAN IP).
 * Prefers common interface names (en0, eth0) then falls back to any external IPv4.
 */
export function pickPrimaryLanIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  const preferredNames = ["en0", "eth0"];
  for (const name of preferredNames) {
    const list = nets[name];
    const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
    if (entry?.address) {
      return entry.address;
    }
  }
  for (const list of Object.values(nets)) {
    const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
    if (entry?.address) {
      return entry.address;
    }
  }
  return undefined;
}

export function normalizeHostHeader(hostHeader?: string): string {
  return (hostHeader ?? "").trim().toLowerCase();
}

export function resolveHostName(hostHeader?: string): string {
  const host = normalizeHostHeader(hostHeader);
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  // Unbracketed IPv6 host (e.g. "::1") has no port and should be returned as-is.
  if (net.isIP(host) === 6) {
    return host;
  }
  const [name] = host.split(":");
  return name ?? "";
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  return isLoopbackIpAddress(ip);
}

/**
 * Returns true if the IP belongs to a private or loopback network range.
 * Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
 */
export function isPrivateOrLoopbackAddress(ip: string | undefined): boolean {
  return isPrivateOrLoopbackIpAddress(ip);
}

function normalizeIp(ip: string | undefined): string | undefined {
  return normalizeIpAddress(ip);
}

function stripOptionalPort(ip: string): string {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end !== -1) {
      return ip.slice(1, end);
    }
  }
  if (net.isIP(ip)) {
    return ip;
  }
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) {
      return candidate;
    }
  }
  return ip;
}

function parseIpLiteral(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = stripOptionalPort(trimmed);
  const normalized = normalizeIp(stripped);
  if (!normalized || net.isIP(normalized) === 0) {
    return undefined;
  }
  return normalized;
}

function parseRealIp(realIp?: string): string | undefined {
  return parseIpLiteral(realIp);
}

function resolveForwardedClientIp(params: {
  forwardedFor?: string;
  trustedProxies?: string[];
}): string | undefined {
  const { forwardedFor, trustedProxies } = params;
  if (!trustedProxies?.length) {
    return undefined;
  }

  const forwardedChain: string[] = [];
  for (const entry of forwardedFor?.split(",") ?? []) {
    const normalized = parseIpLiteral(entry);
    if (normalized) {
      forwardedChain.push(normalized);
    }
  }
  if (forwardedChain.length === 0) {
    return undefined;
  }

  // Walk right-to-left and return the first untrusted hop.
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    const hop = forwardedChain[index];
    if (!isTrustedProxyAddress(hop, trustedProxies)) {
      return hop;
    }
  }
  return undefined;
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) {
    return false;
  }

  return trustedProxies.some((proxy) => {
    const candidate = proxy.trim();
    if (!candidate) {
      return false;
    }
    return isIpInCidr(normalized, candidate);
  });
}

export function resolveClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
  /** Default false: only trust X-Real-IP when explicitly enabled. */
  allowRealIpFallback?: boolean;
}): string | undefined {
  const remote = normalizeIp(params.remoteAddr);
  if (!remote) {
    return undefined;
  }
  if (!isTrustedProxyAddress(remote, params.trustedProxies)) {
    return remote;
  }
  // Fail closed when traffic comes from a trusted proxy but client-origin headers
  // are missing or invalid. Falling back to the proxy's own IP can accidentally
  // treat unrelated requests as local/trusted.
  const forwardedIp = resolveForwardedClientIp({
    forwardedFor: params.forwardedFor,
    trustedProxies: params.trustedProxies,
  });
  if (forwardedIp) {
    return forwardedIp;
  }
  if (params.allowRealIpFallback) {
    return parseRealIp(params.realIp);
  }
  return undefined;
}

export function isLocalGatewayAddress(ip: string | undefined): boolean {
  if (isLoopbackAddress(ip)) {
    return true;
  }
  if (!ip) {
    return false;
  }
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return false;
  }
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  if (tailnetIPv4 && normalized === tailnetIPv4.toLowerCase()) {
    return true;
  }
  const tailnetIPv6 = pickPrimaryTailnetIPv6();
  if (tailnetIPv6 && ip.trim().toLowerCase() === tailnetIPv6.toLowerCase()) {
    return true;
  }
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
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0"; // extreme fallback
  }

  if (mode === "tailnet") {
    const tailnetIP = pickPrimaryTailnetIPv4();
    if (tailnetIP && (await canBindToHost(tailnetIP))) {
      return tailnetIP;
    }
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
    return "0.0.0.0";
  }

  if (mode === "lan") {
    return "0.0.0.0";
  }

  if (mode === "custom") {
    const host = customHost?.trim();
    if (!host) {
      return "0.0.0.0";
    } // invalid config → fall back to all

    if (isValidIPv4(host) && (await canBindToHost(host))) {
      return host;
    }
    // Custom IP failed → fall back to LAN
    return "0.0.0.0";
  }

  if (mode === "auto") {
    if (await canBindToHost("127.0.0.1")) {
      return "127.0.0.1";
    }
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
  if (bindHost !== "127.0.0.1") {
    return [bindHost];
  }
  const canBind = opts?.canBindToHost ?? canBindToHost;
  if (await canBind("::1")) {
    return [bindHost, "::1"];
  }
  return [bindHost];
}

/**
 * Validate if a string is a valid IPv4 address.
 *
 * @param host - The string to validate
 * @returns True if valid IPv4 format
 */
export function isValidIPv4(host: string): boolean {
  return isCanonicalDottedDecimalIPv4(host);
}

/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) {
    return false;
  }
  const h = host.trim().toLowerCase();
  if (h === "localhost") {
    return true;
  }
  // Handle bracketed IPv6 addresses like [::1]
  const unbracket = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  return isLoopbackAddress(unbracket);
}

/**
 * Local-facing host check for inbound requests:
 * - loopback hosts (localhost/127.x/::1 and mapped forms)
 * - Tailscale Serve/Funnel hostnames (*.ts.net)
 */
export function isLocalishHost(hostHeader?: string): boolean {
  const host = resolveHostName(hostHeader);
  if (!host) {
    return false;
  }
  return isLoopbackHost(host) || host.endsWith(".ts.net");
}

/**
 * Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
 *
 * Returns true if the URL is secure for transmitting data:
 * - wss:// (TLS) is always secure
 * - ws:// is only secure for loopback addresses (localhost, 127.x.x.x, ::1)
 *
 * All other ws:// URLs are considered insecure because both credentials
 * AND chat/conversation data would be exposed to network interception.
 */
export function isSecureWebSocketUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === "wss:") {
    return true;
  }

  if (parsed.protocol !== "ws:") {
    return false;
  }

  // ws:// is only secure for loopback addresses
  return isLoopbackHost(parsed.hostname);
}
