/** Runtime-aligned trusted-proxy readiness checks used by doctor security diagnostics. */
import { validateHeaderName, validateHeaderValue } from "node:http";
import { normalizeIpAddress, parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/config.js";
import {
  assertGatewayAuthConfigured,
  authorizeHttpGatewayConnect,
  resolveGatewayAuth,
} from "../gateway/auth.js";
import { isTrustedProxyAddress } from "../gateway/net.js";

type TrustedProxySource = {
  entry: string;
  address: string;
};

type TrustedProxyReadiness = {
  problems: string[];
};

type IpRange = {
  start: bigint;
  end: bigint;
};

const UNUSABLE_PROXY_SOURCE_RANGES: Record<32 | 128, readonly IpRange[]> = {
  32: [
    { start: 0x0n, end: 0x00ffffffn },
    { start: 0xe0000000n, end: 0xefffffffn },
    { start: 0xffffffffn, end: 0xffffffffn },
  ],
  128: [
    { start: 0x0n, end: 0x0n },
    { start: 0xff000000000000000000000000000000n, end: 0xffffffffffffffffffffffffffffffffn },
  ],
};

function ipBytesToBigInt(bytes: readonly number[]): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function formatIpValue(value: bigint, bits: 32 | 128): string {
  const bytes = Array.from({ length: bits / 8 }, (_, index) => {
    const shift = BigInt(bits - (index + 1) * 8);
    return Number((value >> shift) & 0xffn);
  });
  if (bits === 32) {
    return bytes.join(".");
  }
  const hextets = Array.from({ length: 8 }, (_, index) => {
    const high = bytes[index * 2] ?? 0;
    const low = bytes[index * 2 + 1] ?? 0;
    return ((high << 8) | low).toString(16);
  });
  return hextets.join(":");
}

function parseHostScopedTrustedProxySource(entry: string): TrustedProxySource | undefined {
  const parts = entry.split("/");
  if (parts.length > 2) {
    return undefined;
  }
  const rawAddress = parts[0]?.trim() ?? "";
  const parsedAddress = parseCanonicalIpAddress(rawAddress);
  if (!parsedAddress) {
    return undefined;
  }
  const rawBits: 32 | 128 = parsedAddress.kind() === "ipv6" ? 128 : 32;
  const rawPrefix = parts.length === 1 ? rawBits : Number(parts[1]?.trim());
  // Doctor only downgrades host-scoped proxy identities. The public setup
  // checklist requires actual proxy IPs, not subnets, because every address in
  // a trusted CIDR can forge the configured identity headers.
  if (!Number.isInteger(rawPrefix) || rawPrefix !== rawBits) {
    return undefined;
  }
  const normalizedAddress = parseCanonicalIpAddress(normalizeIpAddress(rawAddress));
  if (!normalizedAddress) {
    return undefined;
  }
  const bits: 32 | 128 = normalizedAddress.kind() === "ipv6" ? 128 : 32;
  const value = ipBytesToBigInt(normalizedAddress.toByteArray());
  if (
    UNUSABLE_PROXY_SOURCE_RANGES[bits].some((range) => range.start <= value && value <= range.end)
  ) {
    return undefined;
  }
  const address = formatIpValue(value, bits);
  return isTrustedProxyAddress(address, [entry]) ? { entry, address } : undefined;
}

async function isPotentiallyUsableProxySource(
  source: TrustedProxySource,
  auth: ReturnType<typeof resolveGatewayAuth>,
): Promise<boolean> {
  const trustedProxy = auth.trustedProxy;
  if (!trustedProxy) {
    return false;
  }
  const allowUsers = trustedProxy.allowUsers ?? [];
  const userHeader = normalizeLowercaseStringOrEmpty(trustedProxy.userHeader);
  // Runtime trims the presented identity before comparing it with allowUsers,
  // so only an already-normalized entry can satisfy a non-empty allowlist.
  const user =
    allowUsers.length === 0
      ? "doctor-probe"
      : allowUsers.find((entry) => {
          if (normalizeOptionalString(entry) !== entry) {
            return false;
          }
          try {
            validateHeaderValue(userHeader, entry);
            return true;
          } catch {
            return false;
          }
        });
  if (!user) {
    return false;
  }
  const headers: Record<string, string> = {};
  for (const header of trustedProxy.requiredHeaders ?? []) {
    headers[normalizeLowercaseStringOrEmpty(header)] = "present";
  }
  headers[userHeader] = user;

  const result = await authorizeHttpGatewayConnect({
    auth,
    connectAuth: null,
    trustedProxies: [source.entry],
    req: { socket: { remoteAddress: source.address }, headers } as never,
  });
  return result.ok;
}

export async function resolveTrustedProxyReadiness(params: {
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
}): Promise<TrustedProxyReadiness> {
  const problems: string[] = [];
  try {
    assertGatewayAuthConfigured(params.auth, params.cfg.gateway?.auth);
  } catch (error) {
    problems.push(
      error instanceof Error ? error.message : "Gateway rejected the trusted-proxy config.",
    );
  }
  const trustedProxy = params.auth.trustedProxy;
  if (!trustedProxy) {
    if (problems.length === 0) {
      problems.push("Gateway rejected the trusted-proxy config.");
    }
  } else {
    for (const [path, header] of [
      ["gateway.auth.trustedProxy.userHeader", trustedProxy.userHeader],
      ...(trustedProxy.requiredHeaders ?? []).map(
        (entry, index) => [`gateway.auth.trustedProxy.requiredHeaders[${index}]`, entry] as const,
      ),
    ] as const) {
      const normalizedHeader = normalizeLowercaseStringOrEmpty(header);
      // The runtime assertion above owns the empty userHeader diagnostic.
      if (path === "gateway.auth.trustedProxy.userHeader" && normalizedHeader === "") {
        continue;
      }
      if (normalizedHeader === "__proto__") {
        problems.push(
          `${path} is not a deliverable HTTP header name, so a proxy cannot supply it.`,
        );
        continue;
      }
      try {
        validateHeaderName(normalizedHeader);
      } catch {
        problems.push(`${path} is not a valid HTTP header name, so a proxy cannot supply it.`);
      }
    }
  }
  const trustedProxies = (params.cfg.gateway?.trustedProxies ?? [])
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => entry !== undefined);
  if (trustedProxies.length === 0) {
    problems.push(
      "gateway.trustedProxies is empty, so every trusted-proxy request will be rejected.",
    );
  }
  const sources = trustedProxies.map(parseHostScopedTrustedProxySource);
  if (sources.some((source) => source === undefined)) {
    problems.push(
      "gateway.trustedProxies includes an invalid or unusable source, or a non-host-scoped CIDR; use canonical usable unicast proxy IPs (exact, /32, or /128).",
    );
  }
  // Runtime authorization assumes all static prerequisites above are valid. Preserve every static
  // diagnostic, then avoid probing with malformed headers or mutually exclusive auth settings.
  if (problems.length > 0) {
    return { problems };
  }
  for (const source of sources) {
    if (source && (await isPotentiallyUsableProxySource(source, params.auth))) {
      return { problems: [] };
    }
  }
  return {
    problems: [
      "No configured proxy source can pass the Gateway's source checks in this runtime environment.",
    ],
  };
}
