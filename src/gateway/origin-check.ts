import { isLoopbackAddress, isLoopbackHost, normalizeHostHeader } from "./net.js";

type OriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "host-header-fallback" | "local-loopback" | "loopback-socket";
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
  /** True when the TCP socket remote address is loopback. Used to relax origin checks for local connections that arrive through a local proxy (e.g. dev server, VPN) which may inject proxy headers that would otherwise cause isLocalClient to be false. Safe because an external attacker cannot forge a loopback browser origin. */
  isLoopbackSocket?: boolean;
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

  // Loopback-socket fallback: when the TCP connection originates from a loopback address (e.g. 127.0.0.1,
  // ::1, ::ffff:127.0.0.1) AND the browser origin is also loopback, allow the connection even if proxy headers
  // are present. This covers Windows scenarios where local VPN/antivirus/dev-server proxy software injects
  // x-forwarded-for headers that would otherwise cause isLocalClient to be false.
  // Safe because an external attacker cannot forge a loopback browser origin — the browser's origin is
  // determined by the page URL, and only pages served from localhost/127.0.0.1 produce loopback origins.
  if (params.isLoopbackSocket && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "loopback-socket" };
  }

  return { ok: false, reason: "origin not allowed" };
}
