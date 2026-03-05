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

  const requestForwardedHost = normalizeHostHeader(params.requestForwardedHost);
  if (requestForwardedHost) {
    const normalizedForwardedHost = requestForwardedHost.toLowerCase();

    // Security: Origin MUST match the forwarded host (cross-validation)
    if (parsedOrigin.host !== normalizedForwardedHost) {
      return { ok: false, reason: "origin does not match forwarded host" };
    }

    // Security: Check the full origin (with scheme) is in allowlist
    if (allowlist.has(parsedOrigin.origin)) {
      return { ok: true, matchedBy: "allowlist" };
    }

    // Legacy fallback for forwarded host with explicit opt-in
    if (params.allowHostHeaderOriginFallback === true) {
      return { ok: true, matchedBy: "host-header-fallback" };
    }
  }

  const directRequestHost = normalizeHostHeader(params.requestHost);
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
