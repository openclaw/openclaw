import { lookup as dnsLookup } from "node:dns/promises";
import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { Agent, type Dispatcher } from "undici";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrFBlockedError";
  }
}

type LookupFn = typeof dnsLookup;

const PRIVATE_IPV6_PREFIXES = ["fe80:", "fec0:", "fc", "fd"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

// Cloud instance metadata service (IMDS) endpoints that must remain blocked
// even when allowPrivateNetwork is enabled to prevent credential harvesting.
const IMDS_HOSTNAMES = new Set(["metadata.google.internal"]);

// Store IMDS IPs in canonical form for reliable matching regardless of
// how the address is spelled (e.g. fd00:ec2::254 vs fd00:ec2:0:0:0:0:0:254).
const IMDS_IPV4_ADDRESSES = new Set(["169.254.169.254"]);
const IMDS_IPV6_GROUPS: number[][] = [
  [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254], // fd00:ec2::254
];

/**
 * Parse an IPv6 address string into 8 16-bit groups.
 * Handles :: expansion and returns null on invalid input.
 */
function parseIpv6Groups(address: string): number[] | null {
  // Handle IPv4-mapped suffix (::ffff:1.2.3.4)
  const lastColon = address.lastIndexOf(":");
  const tail = lastColon >= 0 ? address.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const prefix = address.slice(0, lastColon);
    const prefixGroups = parseIpv6Groups(prefix + ":0:0");
    if (!prefixGroups) return null;
    // Replace last two groups with the IPv4 octets
    prefixGroups[6] = (v4[0] << 8) | v4[1];
    prefixGroups[7] = (v4[2] << 8) | v4[3];
    return prefixGroups;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    const groups: number[] = [];
    for (const p of parts) {
      if (p.length === 0 || p.length > 4) return null;
      const val = Number.parseInt(p, 16);
      if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
      groups.push(val);
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseHalf(halves[0]);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1]);
  if (!left || !right) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array(fill).fill(0), ...right];
}

/** Check whether an address matches a known IMDS IP. */
function isImdsAddress(address: string): boolean {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  // Direct IPv4 match
  if (IMDS_IPV4_ADDRESSES.has(normalized)) return true;

  // Extract IPv4 from IPv6-mapped forms (::ffff:169.254.169.254 or ::ffff:a9fe:a9fe)
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (IMDS_IPV4_ADDRESSES.has(mapped)) return true;
    const v4 = parseIpv4FromMappedIpv6(mapped);
    if (v4 && IMDS_IPV4_ADDRESSES.has(v4.join("."))) return true;
  }

  // Canonical IPv6 group comparison to handle any spelling variant
  if (normalized.includes(":")) {
    const groups = parseIpv6Groups(normalized);
    if (groups && groups.length === 8) {
      for (const imdsGroups of IMDS_IPV6_GROUPS) {
        if (groups.every((g, i) => g === imdsGroups[i])) return true;
      }
    }
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return null;
  return numbers;
}

function parseIpv4FromMappedIpv6(mapped: string): number[] | null {
  if (mapped.includes(".")) {
    return parseIpv4(mapped);
  }
  const parts = mapped.split(":").filter(Boolean);
  if (parts.length === 1) {
    const value = Number.parseInt(parts[0], 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff_ffff) return null;
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  }
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (
    Number.isNaN(high) ||
    Number.isNaN(low) ||
    high < 0 ||
    low < 0 ||
    high > 0xffff ||
    low > 0xffff
  ) {
    return null;
  }
  const value = (high << 16) + low;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function isPrivateIpv4(parts: number[]): boolean {
  const [octet1, octet2] = parts;
  if (octet1 === 0) return true;
  if (octet1 === 10) return true;
  if (octet1 === 127) return true;
  if (octet1 === 169 && octet2 === 254) return true;
  if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
  if (octet1 === 192 && octet2 === 168) return true;
  if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) return true;
  return false;
}

export function isPrivateIpAddress(address: string): boolean {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (!normalized) return false;

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    const ipv4 = parseIpv4FromMappedIpv6(mapped);
    if (ipv4) return isPrivateIpv4(ipv4);
  }

  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1") return true;
    return PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  const ipv4 = parseIpv4(normalized);
  if (!ipv4) return false;
  return isPrivateIpv4(ipv4);
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return (
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

export function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof dnsLookupCb;
}): typeof dnsLookupCb {
  const normalizedHost = normalizeHostname(params.hostname);
  const fallback = params.fallback ?? dnsLookupCb;
  const fallbackLookup = fallback as unknown as (
    hostname: string,
    callback: LookupCallback,
  ) => void;
  const fallbackWithOptions = fallback as unknown as (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ) => void;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) return;
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return fallbackLookup(host, cb);
      }
      return fallbackWithOptions(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as { all?: boolean; family?: number })
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as LookupAddress[]);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dnsLookupCb;
}

export type PinnedHostname = {
  hostname: string;
  addresses: string[];
  lookup: typeof dnsLookupCb;
};

export async function resolvePinnedHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
  options?: { allowPrivateNetwork?: boolean },
): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error("Invalid hostname");
  }

  const allowPrivate = options?.allowPrivateNetwork === true;

  // Always block cloud IMDS endpoints regardless of allowPrivateNetwork.
  if (IMDS_HOSTNAMES.has(normalized)) {
    throw new SsrFBlockedError(`Blocked hostname: ${hostname}`);
  }
  if (isImdsAddress(normalized)) {
    throw new SsrFBlockedError("Blocked: cloud metadata service IP address");
  }

  if (!allowPrivate && isBlockedHostname(normalized)) {
    throw new SsrFBlockedError(`Blocked hostname: ${hostname}`);
  }

  if (!allowPrivate && isPrivateIpAddress(normalized)) {
    throw new SsrFBlockedError("Blocked: private/internal IP address");
  }

  // When the hostname is a private IP literal and allowed, skip DNS lookup
  // and pin directly to the literal address.
  if (allowPrivate && isPrivateIpAddress(normalized)) {
    return {
      hostname: normalized,
      addresses: [normalized],
      lookup: createPinnedLookup({ hostname: normalized, addresses: [normalized] }),
    };
  }

  const results = await lookupFn(normalized, { all: true });
  if (results.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  for (const entry of results) {
    // Always block IMDS IPs even when allowPrivateNetwork is enabled.
    if (isImdsAddress(entry.address)) {
      throw new SsrFBlockedError("Blocked: resolves to cloud metadata service IP address");
    }
    if (!allowPrivate && isPrivateIpAddress(entry.address)) {
      throw new SsrFBlockedError("Blocked: resolves to private/internal IP address");
    }
  }

  const addresses = Array.from(new Set(results.map((entry) => entry.address)));
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

export function createPinnedDispatcher(pinned: PinnedHostname): Dispatcher {
  return new Agent({
    connect: {
      lookup: pinned.lookup,
    },
  });
}

export async function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void> {
  if (!dispatcher) return;
  const candidate = dispatcher as { close?: () => Promise<void> | void; destroy?: () => void };
  try {
    if (typeof candidate.close === "function") {
      await candidate.close();
      return;
    }
    if (typeof candidate.destroy === "function") {
      candidate.destroy();
    }
  } catch {
    // ignore dispatcher cleanup errors
  }
}

export async function assertPublicHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
): Promise<void> {
  await resolvePinnedHostname(hostname, lookupFn);
}
