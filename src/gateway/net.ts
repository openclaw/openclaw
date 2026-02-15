import net from "node:net";
import os from "node:os";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";

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

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  if (ip === "127.0.0.1") {
    return true;
  }
  if (ip.startsWith("127.")) {
    return true;
  }
  if (ip === "::1") {
    return true;
  }
  if (ip.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}

function normalizeIPv4MappedAddress(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }
  return ip;
}

function normalizeIp(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeIPv4MappedAddress(trimmed.toLowerCase());
}

function normalizeIpMaybeWithPort(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeIp(stripOptionalPort(trimmed));
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

export function parseForwardedForClientIp(forwardedFor?: string): string | undefined {
  const raw = forwardedFor?.split(",")[0]?.trim();
  if (!raw) {
    return undefined;
  }
  return normalizeIp(stripOptionalPort(raw));
}

function parseRealIp(realIp?: string): string | undefined {
  const raw = realIp?.trim();
  if (!raw) {
    return undefined;
  }
  return normalizeIp(stripOptionalPort(raw));
}

type ParsedCidr = {
  family: 4 | 6;
  prefix: number;
  network: Uint8Array;
};

const PRIVATE_PROXY_CIDRS = [
  "127.0.0.0/8",
  "::1/128",
  "::ffff:127.0.0.0/104",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  "fe80::/10",
];

function parseIPv4Bytes(ip: string): Uint8Array | null {
  const normalized = normalizeIpMaybeWithPort(ip);
  if (!normalized || net.isIP(normalized) !== 4) {
    return null;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    bytes[i] = n;
  }
  return bytes;
}

function parseIPv6Bytes(ip: string): Uint8Array | null {
  const normalized = normalizeIpMaybeWithPort(ip);
  if (!normalized) {
    return null;
  }
  const zoneStripped = normalized.split("%")[0] ?? normalized;
  if (net.isIP(zoneStripped) !== 6) {
    return null;
  }

  const doubleParts = zoneStripped.split("::");
  if (doubleParts.length > 2) {
    return null; // more than one '::'
  }
  const headRaw = doubleParts[0] ?? "";
  const tailRaw = doubleParts[1];

  const headParts = headRaw ? headRaw.split(":").filter(Boolean) : [];
  const tailParts = tailRaw ? tailRaw.split(":").filter(Boolean) : [];

  const expandIPv4Tail = (parts: string[]): string[] => {
    const last = parts.at(-1);
    if (!last || !last.includes(".")) {
      return parts;
    }
    const v4 = parseIPv4Bytes(last);
    if (!v4) {
      return parts;
    }
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    return [...parts.slice(0, -1), hi.toString(16), lo.toString(16)];
  };

  const head = expandIPv4Tail(headParts);
  const tail = expandIPv4Tail(tailParts);

  const hasDoubleColon = doubleParts.length === 2;
  const totalParts = head.length + tail.length;
  if (!hasDoubleColon && totalParts !== 8) {
    return null;
  }
  if (hasDoubleColon && totalParts > 8) {
    return null;
  }

  const zerosToInsert = hasDoubleColon ? 8 - totalParts : 0;
  const fullParts = [...head, ...Array.from({ length: zerosToInsert }, () => "0"), ...tail];
  if (fullParts.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const part = fullParts[i] ?? "";
    const n = Number.parseInt(part, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) {
      return null;
    }
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function applyPrefixMask(bytes: Uint8Array, prefix: number): Uint8Array {
  const masked = new Uint8Array(bytes);
  const fullBytes = Math.floor(prefix / 8);
  const remainder = prefix % 8;

  for (let i = fullBytes + (remainder > 0 ? 1 : 0); i < masked.length; i++) {
    masked[i] = 0;
  }

  if (remainder > 0 && fullBytes < masked.length) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    masked[fullBytes] = masked[fullBytes] & mask;
  }

  return masked;
}

function parseCidr(value: string): ParsedCidr | null {
  const trimmed = value.trim();
  const slashIdx = trimmed.lastIndexOf("/");
  if (slashIdx <= 0) {
    return null;
  }
  const addrRaw = trimmed.slice(0, slashIdx).trim();
  const prefixRaw = trimmed.slice(slashIdx + 1).trim();
  if (!addrRaw || !prefixRaw) {
    return null;
  }
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!Number.isInteger(prefix)) {
    return null;
  }

  const addr = normalizeIpMaybeWithPort(addrRaw);
  if (!addr) {
    return null;
  }

  const family = net.isIP(addr);
  if (family === 4) {
    if (prefix < 0 || prefix > 32) {
      return null;
    }
    const bytes = parseIPv4Bytes(addr);
    if (!bytes) {
      return null;
    }
    return { family: 4, prefix, network: applyPrefixMask(bytes, prefix) };
  }
  if (family === 6) {
    if (prefix < 0 || prefix > 128) {
      return null;
    }
    const bytes = parseIPv6Bytes(addr);
    if (!bytes) {
      return null;
    }
    return { family: 6, prefix, network: applyPrefixMask(bytes, prefix) };
  }
  return null;
}

function isIpInCidr(ip: string, cidr: ParsedCidr): boolean {
  const normalized = normalizeIpMaybeWithPort(ip);
  if (!normalized) {
    return false;
  }
  const family = net.isIP(normalized);
  if (family !== cidr.family) {
    return false;
  }

  const bytes =
    cidr.family === 4
      ? parseIPv4Bytes(normalized)
      : cidr.family === 6
        ? parseIPv6Bytes(normalized)
        : null;
  if (!bytes) {
    return false;
  }

  const fullBytes = Math.floor(cidr.prefix / 8);
  const remainder = cidr.prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== cidr.network[i]) {
      return false;
    }
  }
  if (remainder > 0) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    if (((bytes[fullBytes] ?? 0) & mask) !== ((cidr.network[fullBytes] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

export function resolveTrustedProxies(
  configured?: string[] | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = Array.isArray(configured)
    ? configured.map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry))
    : [];

  const isRailway =
    Boolean(env.RAILWAY_STATIC_URL) ||
    Boolean(env.RAILWAY_ENVIRONMENT) ||
    Boolean(env.RAILWAY_SERVICE_NAME);
  const allowPrivateRanges = env.OPENCLAW_TRUST_PROXY_PRIVATE === "1" || isRailway;

  if (allowPrivateRanges) {
    for (const cidr of PRIVATE_PROXY_CIDRS) {
      if (!base.includes(cidr)) {
        base.push(cidr);
      }
    }
  }
  return base;
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIpMaybeWithPort(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) {
    return false;
  }

  return trustedProxies.some((proxy) => {
    const raw = proxy?.trim();
    if (!raw) {
      return false;
    }
    if (raw.includes("/")) {
      const cidr = parseCidr(raw);
      return cidr ? isIpInCidr(normalized, cidr) : false;
    }
    return normalizeIpMaybeWithPort(raw) === normalized;
  });
}

export function resolveGatewayClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
}): string | undefined {
  const remote = normalizeIpMaybeWithPort(params.remoteAddr);
  if (!remote) {
    return undefined;
  }
  if (!isTrustedProxyAddress(remote, params.trustedProxies)) {
    return remote;
  }
  return parseForwardedForClientIp(params.forwardedFor) ?? parseRealIp(params.realIp) ?? remote;
}

export function isLocalGatewayAddress(ip: string | undefined): boolean {
  if (isLoopbackAddress(ip)) {
    return true;
  }
  if (!ip) {
    return false;
  }
  const normalized = normalizeIPv4MappedAddress(ip.trim().toLowerCase());
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
function isValidIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    const n = parseInt(part, 10);
    return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
  });
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}
