/**
 * Network egress guard for local-model-only security mode.
 *
 * Enforces that outbound HTTP/HTTPS requests stay within the allowed
 * network boundary (corporate LAN). When `localModelSecurity.mode` is
 * "enforced", requests to external hosts are blocked. In "audit" mode,
 * violations are logged but not blocked.
 */

import { isIP } from "node:net";
import type {
  AllowedLocalHost,
  LocalModelSecurityConfig,
  LocalModelSecurityMode,
} from "../config/types.local-model-security.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/network-egress");

// Well-known cloud AI provider hostnames that should be blocked in local-only mode.
const CLOUD_PROVIDER_HOSTNAMES = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.cohere.ai",
  "api.together.xyz",
  "openrouter.ai",
  "api.minimax.io",
  "api.moonshot.ai",
  "api.kimi.com",
  "portal.qwen.ai",
  "integrate.api.nvidia.com",
  "qianfan.baidubce.com",
  "api.xiaomimimo.com",
  "api-inference.huggingface.co",
  "bedrock-runtime.us-east-1.amazonaws.com",
  "bedrock-runtime.us-west-2.amazonaws.com",
  "bedrock-runtime.eu-west-1.amazonaws.com",
  "api.venice.ai",
]);

// RFC 1918 private ranges + link-local + loopback.
const DEFAULT_PRIVATE_RANGES = [
  { prefix: [10], bits: 8 },
  { prefix: [172, 16], bits: 12 },
  { prefix: [192, 168], bits: 16 },
  { prefix: [127], bits: 8 },
  { prefix: [169, 254], bits: 16 },
] as const;

export class NetworkEgressBlockedError extends Error {
  public readonly hostname: string;
  public readonly mode: LocalModelSecurityMode;

  constructor(hostname: string, mode: LocalModelSecurityMode) {
    super(
      `Network egress blocked: ${hostname} is not in the allowed hosts list (localModelSecurity.mode=${mode})`,
    );
    this.name = "NetworkEgressBlockedError";
    this.hostname = hostname;
    this.mode = mode;
  }
}

export type EgressCheckResult = {
  allowed: boolean;
  reason: string;
  hostname: string;
  mode: LocalModelSecurityMode;
};

/**
 * Parse an IPv4 address string into its four octets, or return null.
 */
function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

/**
 * Check whether an IPv4 address falls within one of the default private ranges.
 */
function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return false;
  }
  for (const range of DEFAULT_PRIVATE_RANGES) {
    let match = true;
    for (let i = 0; i < range.prefix.length; i++) {
      if (range.bits >= (i + 1) * 8) {
        if (octets[i] !== range.prefix[i]) {
          match = false;
          break;
        }
      } else {
        // Partial octet matching for /12 (172.16.0.0/12)
        const maskBits = range.bits - i * 8;
        const mask = 0xff << (8 - maskBits);
        if ((octets[i] & mask) !== (range.prefix[i] & mask)) {
          match = false;
          break;
        }
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether an IPv6 address is a loopback (::1) or link-local (fe80::/10).
 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80%")) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:192.168.x.x)
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (v4Mapped?.[1]) {
    return isPrivateIpv4(v4Mapped[1]);
  }
  return false;
}

/**
 * Determine whether an IP address is within a private/local network range.
 */
export function isLocalNetworkAddress(address: string): boolean {
  const trimmed = address.trim();
  if (isIP(trimmed) === 4) {
    return isPrivateIpv4(trimmed);
  }
  if (isIP(trimmed) === 6) {
    return isPrivateIpv6(trimmed);
  }
  return false;
}

/**
 * Extract hostname and port from a URL string.
 */
function parseHostFromUrl(url: string): { hostname: string; port: number | undefined } | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : undefined;
    // Strip IPv6 brackets: new URL("http://[::1]:11434").hostname === "[::1]"
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    return { hostname, port };
  } catch {
    return null;
  }
}

/**
 * Check whether a hostname matches the allowed hosts list.
 */
function isHostAllowed(
  hostname: string,
  port: number | undefined,
  allowedHosts: AllowedLocalHost[],
): boolean {
  for (const entry of allowedHosts) {
    const entryHost = entry.host.toLowerCase();
    if (entryHost !== hostname) {
      continue;
    }
    // If a port restriction is set, enforce it.
    if (entry.port !== undefined && port !== undefined && entry.port !== port) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Check whether a hostname is a known cloud AI provider.
 */
export function isCloudProviderHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (CLOUD_PROVIDER_HOSTNAMES.has(lower)) {
    return true;
  }
  // Catch wildcard patterns like *.amazonaws.com for Bedrock.
  if (lower.endsWith(".amazonaws.com") && lower.includes("bedrock")) {
    return true;
  }
  return false;
}

/**
 * Resolve the effective security mode from the config.
 */
export function resolveSecurityMode(config?: LocalModelSecurityConfig): LocalModelSecurityMode {
  return config?.mode ?? "off";
}

/**
 * Check whether a URL is allowed by the network egress policy.
 */
export function checkEgressPolicy(
  url: string,
  config?: LocalModelSecurityConfig,
): EgressCheckResult {
  const mode = resolveSecurityMode(config);
  if (mode === "off") {
    return { allowed: true, reason: "local-model-security is off", hostname: "", mode };
  }

  const parsed = parseHostFromUrl(url);
  if (!parsed) {
    return { allowed: false, reason: "invalid URL", hostname: url, mode };
  }

  const { hostname, port } = parsed;
  const policy = config?.networkEgress;

  // Always allow loopback.
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return { allowed: true, reason: "loopback address", hostname, mode };
  }

  // Check explicit allowed hosts.
  const allowedHosts = policy?.allowedHosts ?? [];
  if (isHostAllowed(hostname, port, allowedHosts)) {
    return { allowed: true, reason: "in allowed hosts list", hostname, mode };
  }

  // Check if it's a private/LAN IP address.
  if (isIP(hostname) && isLocalNetworkAddress(hostname)) {
    return { allowed: true, reason: "private/LAN IP address", hostname, mode };
  }

  // Block cloud providers when configured.
  if (config?.blockCloudProviders !== false && isCloudProviderHost(hostname)) {
    return { allowed: false, reason: "cloud provider blocked in local-only mode", hostname, mode };
  }

  // Block external requests when configured.
  if (policy?.blockExternalRequests !== false) {
    return {
      allowed: false,
      reason: "external request blocked by network egress policy",
      hostname,
      mode,
    };
  }

  return { allowed: true, reason: "no restriction matched", hostname, mode };
}

/**
 * Enforce the egress policy: throw on "enforced" mode, log on "audit" mode.
 */
export function enforceEgressPolicy(url: string, config?: LocalModelSecurityConfig): void {
  const result = checkEgressPolicy(url, config);
  if (result.allowed) {
    return;
  }

  if (result.mode === "audit") {
    log.warn(`[AUDIT] Egress violation: ${result.reason} — ${result.hostname} (URL: ${url})`);
    return;
  }

  // mode === "enforced"
  log.error(`[BLOCKED] Egress violation: ${result.reason} — ${result.hostname} (URL: ${url})`);
  throw new NetworkEgressBlockedError(result.hostname, result.mode);
}

/**
 * Build the list of blocked cloud provider domains for display/audit.
 */
export function getBlockedCloudProviders(): readonly string[] {
  return Array.from(CLOUD_PROVIDER_HOSTNAMES).toSorted();
}
