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

function normalizeHostToMatchUrlHost(host: string | undefined): string | undefined {
  const normalized = normalizeHostHeader(host);
  if (!normalized) {
    return undefined;
  }
  // Use URL parsing to exactly match URL.host semantics
  // This strips default ports (:80 for http, :443 for https) but keeps non-standard ports
  // e.g., "gateway.ts.net:443" with https:// becomes "gateway.ts.net"
  // e.g., "gateway.ts.net:80" with http:// becomes "gateway.ts.net"
  // e.g., "gateway.ts.net:8080" stays "gateway.ts.net:8080"
  // e.g., "gateway.ts.net:443" with http:// stays "gateway.ts.net:443"
  try {
    // Try as full URL first
    const url = new URL(normalized);
    return url.host.toLowerCase();
  } catch {
    // Fallback: if it's just a host:port without scheme, assume https (common for X-Forwarded-Host)
    // and strip :443 only (common case for HTTPS gateways)
    return normalized.replace(/:443$/, "").toLowerCase();
  }
}

export function checkBrowserOrigin(params: {
  requestHost?: string;
  requestForwardedHost?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlistOrigins = (params.allowedOrigins ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowlist = new Set(allowlistOrigins);

  if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) {
    return { ok: true, matchedBy: "allowlist" };
  }

  const requestForwardedHost = normalizeHostToMatchUrlHost(params.requestForwardedHost);
  if (requestForwardedHost) {
    // Security: Origin MUST match the forwarded host (cross-validation)
    if (parsedOrigin.host !== requestForwardedHost) {
      return { ok: false, reason: "origin does not match forwarded host" };
    }

    // Legacy fallback for forwarded host with explicit opt-in
    // Note: Full-origin allowlist check already ran at line 47 and failed (would have returned early).
    // The forwarded-host path therefore only reaches this explicit fallback opt-in.
    if (params.allowHostHeaderOriginFallback === true) {
      return { ok: true, matchedBy: "host-header-fallback" };
    }
  }

  const directRequestHost = normalizeHostToMatchUrlHost(params.requestHost);
  if (
    params.allowHostHeaderOriginFallback === true &&
    parsedOrigin.host === directRequestHost
  ) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }

  // Dev fallback only for genuinely local socket clients, not Host-header claims.
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  return { ok: false, reason: "origin not allowed" };
}
