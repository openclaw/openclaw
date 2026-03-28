/**
 * Browser origin validation for the WebSocket gateway.
 *
 * Security model (defence-in-depth):
 *
 *  The gateway must not accept WebSocket connections from arbitrary web pages
 *  because that would allow any site the user visits to silently read their
 *  conversation history and issue commands on their behalf (CSRF via WS).
 *
 *  Three acceptance paths, ordered from most to least restrictive:
 *
 *  1. Explicit allowlist  — operator has pre-approved the origin.  A wildcard
 *     "*" is supported for development but MUST NOT be used in production.
 *
 *  2. Host-header fallback  — opt-in only.  Accepts the connection when the
 *     parsed Origin host matches the HTTP Host header.  Useful for reverse-
 *     proxy setups where the operator controls both the proxy and the origin.
 *     This path is disabled by default because a compromised proxy or a DNS
 *     rebinding attack can forge the Host header.
 *
 *  3. Local-loopback fallback  — accepts connections from loopback origins
 *     (127.x, ::1, localhost) when the TCP connection itself came from a
 *     loopback address (isLocalClient).  This is safe because a loopback
 *     TCP connection cannot be initiated by a remote attacker.
 *
 *  All other origins are rejected with a structured error result.
 */
import { isLoopbackHost, normalizeHostHeader } from "./net.js";

type OriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "host-header-fallback" | "local-loopback";
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
    return {
      origin: url.origin.toLowerCase(),
      host: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

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
    (params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
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

  // Dev fallback only for genuinely local socket clients, not Host-header claims.
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  return { ok: false, reason: "origin not allowed" };
}
