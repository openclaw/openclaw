import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "./net.js";

type OriginCheckResult = { ok: true } | { ok: false; reason: string };

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
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlist = (params.allowedOrigins ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.includes(parsedOrigin.origin)) {
    return { ok: true };
  }

  // Same-origin check: try both HTTP and HTTPS since the Host header has no protocol.
  // URL handles default port normalization (80/443) and IPv6 bracket notation.
  const requestHost = normalizeHostHeader(params.requestHost);
  if (requestHost) {
    for (const scheme of ["http", "https"]) {
      try {
        if (new URL(`${scheme}://${requestHost}`).origin === parsedOrigin.origin) {
          return { ok: true };
        }
      } catch {
        // malformed host header
      }
    }
  }

  // CWE-346: loopback cross-origin requests require explicit allowlisting.
  // Provide an actionable error message for local dev scenarios.
  const requestHostname = resolveHostName(requestHost);
  if (isLoopbackHost(parsedOrigin.hostname) && isLoopbackHost(requestHostname)) {
    return {
      ok: false,
      reason: `origin not allowed (add '${parsedOrigin.origin}' to allowedOrigins)`,
    };
  }

  return { ok: false, reason: "origin not allowed" };
}
