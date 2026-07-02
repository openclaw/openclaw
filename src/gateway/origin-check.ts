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
      matchedBy: "allowlist" | "host-header-fallback" | "private-same-origin" | "local-loopback";
    }
  | { ok: false; reason: string };

function parseOrigin(
  originRaw?: string,
): { origin: string; host: string; hostname: string } | null {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    // Opaque origins ("null") signal a non-standard scheme (e.g. tauri://,
    // electron://) that the URL parser cannot represent. Fall back to manual
    // parsing so custom-scheme origins can be matched against the allowlist.
    if (url.origin === "null") {
      return parseCustomSchemeOrigin(trimmed);
    }
    return {
      origin: normalizeLowercaseStringOrEmpty(url.origin),
      host: normalizeLowercaseStringOrEmpty(url.host),
      hostname: normalizeLowercaseStringOrEmpty(url.hostname),
    };
  } catch {
    return parseCustomSchemeOrigin(trimmed);
  }
}

/**
 * Parse a custom-scheme origin (<scheme>://<host>[:<port>]) that the standard
 * URL constructor cannot handle. Does not validate the scheme beyond basic
 * character checks. Returns null when the string cannot be parsed as an origin.
 */
function parseCustomSchemeOrigin(
  raw: string,
): { origin: string; host: string; hostname: string } | null {
  // Match <scheme>://<host-part> where host-part is everything before /, ?, or #
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(raw);
  if (!match) {
    return null;
  }
  const scheme = normalizeLowercaseStringOrEmpty(match[1]);
  const hostPort = match[2];
  if (!scheme || !hostPort) {
    return null;
  }

  let hostname: string;
  let port = "";
  if (hostPort.startsWith("[")) {
    const bracketEnd = hostPort.indexOf("]");
    if (bracketEnd === -1) return null;
    hostname = hostPort.slice(1, bracketEnd);
    if (hostPort.length > bracketEnd + 1) {
      if (hostPort[bracketEnd + 1] === ":") {
        port = hostPort.slice(bracketEnd + 2);
      } else {
        return null;
      }
    }
  } else {
    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx > 0) {
      hostname = hostPort.slice(0, colonIdx);
      port = hostPort.slice(colonIdx + 1);
    } else {
      hostname = hostPort;
    }
  }

  const normalizedHostname = normalizeLowercaseStringOrEmpty(hostname);
  if (!normalizedHostname) {
    return null;
  }
  const host = normalizeLowercaseStringOrEmpty(
    port ? `${normalizedHostname}:${port}` : normalizedHostname,
  );
  const origin = normalizeLowercaseStringOrEmpty(
    port ? `${scheme}://${normalizedHostname}:${port}` : `${scheme}://${normalizedHostname}`,
  );

  return { origin, host, hostname: normalizedHostname };
}

/** Validate a browser Origin against explicit allowlist, same-host, and local dev rules. */
export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: string[];
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
