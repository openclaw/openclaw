// Browser Origin validator for gateway HTTP and websocket requests.
import net from "node:net";
import { isPrivateOrLoopbackIpAddress } from "@openclaw/net-policy/ip";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "./net.js";

type OriginCheckResult =
  | {
      ok: true;
      matchedBy:
        | "allowlist"
        | "host-header-fallback"
        | "private-same-origin"
        | "local-loopback"
        | "origin-pattern";
      matchedPattern?: string;
    }
  | { ok: false; reason: string };

type ParsedOrigin = {
  origin: string;
  host: string;
  hostname: string;
  protocol: string;
  port: string;
};

function parseOrigin(originRaw?: string): ParsedOrigin | null {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return {
      origin: normalizeLowercaseStringOrEmpty(url.origin),
      host: normalizeLowercaseStringOrEmpty(url.host),
      hostname: normalizeLowercaseStringOrEmpty(url.hostname).replace(/\.+$/, ""),
      protocol: normalizeLowercaseStringOrEmpty(url.protocol),
      port: normalizeLowercaseStringOrEmpty(url.port),
    };
  } catch {
    return null;
  }
}

/** Parse an allowedOriginPattern into its components for matching. Returns null for invalid patterns. */
function parseOriginPattern(
  pattern: string,
): { protocol: string; hostname: string; portWildcard: boolean } | null {
  // Manual parse — new URL rejects * as invalid port.
  const match = pattern.match(/^(https?):\/\/(\[?[^\]]+\]?|[^:/]+):\*$/);
  if (!match) {
    return null;
  }
  const hostname = normalizeLowercaseStringOrEmpty(match[2]).replace(/\.+$/, "");
  // Runtime guard: reject non-loopback hostnames even if schema validation was bypassed.
  if (!isLoopbackHost(hostname)) {
    return null;
  }
  return {
    protocol: normalizeLowercaseStringOrEmpty(match[1] + ":"),
    hostname,
    portWildcard: true,
  };
}

/** Validate a browser Origin against explicit allowlist, same-host, local dev rules, and origin patterns. */
export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowedOriginPatterns?: string[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlist = new Set(
    (params.allowedOrigins ?? [])
      .map((value) => normalizeOptionalLowercaseString(value))
      .filter(Boolean),
  );
  if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) {
    return { ok: true, matchedBy: "allowlist" };
  }

  // Allowed origin patterns — constrained loopback port wildcards.
  const patterns = params.allowedOriginPatterns ?? [];
  for (const pattern of patterns) {
    const parsed = parseOriginPattern(pattern);
    if (!parsed) {
      continue;
    }
    if (
      parsed.protocol === parsedOrigin.protocol &&
      parsed.hostname === parsedOrigin.hostname &&
      parsed.portWildcard
    ) {
      return { ok: true, matchedBy: "origin-pattern", matchedPattern: pattern };
    }
  }

  const requestHost = normalizeHostHeader(params.requestHost);
  if (
    params.allowHostHeaderOriginFallback === true &&
    requestHost &&
    parsedOrigin.host === requestHost
  ) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }
  if (
    requestHost &&
    parsedOrigin.host === requestHost &&
    isTrustedSameOriginHost(requestHost, params.isLocalClient)
  ) {
    return { ok: true, matchedBy: "private-same-origin" };
  }

  // Dev fallback only for genuinely local socket clients, not Host-header claims.
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  return { ok: false, reason: "origin not allowed" };
}

function isTrustedSameOriginHost(hostHeader: string, isLocalClient?: boolean): boolean {
  const hostname = resolveHostName(hostHeader);
  if (!hostname) {
    return false;
  }
  if (isLoopbackHost(hostname)) {
    return isLocalClient !== false;
  }
  if (net.isIP(hostname) !== 0) {
    return isPrivateOrLoopbackIpAddress(hostname);
  }
  return hostname.endsWith(".local") || hostname.endsWith(".ts.net");
}
