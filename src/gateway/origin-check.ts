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
  requestForwardedHost?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlist = new Set(
    (params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) {
    return { ok: true };
  }

  const requestHost = normalizeHostHeader(params.requestHost);
  const requestForwardedHost = normalizeHostHeader(params.requestForwardedHost);
  if (params.allowHostHeaderOriginFallback === true) {
    if (requestHost && parsedOrigin.host === requestHost) {
      return { ok: true };
    }
    if (requestForwardedHost && parsedOrigin.host === requestForwardedHost) {
      return { ok: true };
    }
  }

  const requestHostname = resolveHostName(requestHost);
  const requestForwardedHostname = resolveHostName(requestForwardedHost);
  if (
    isLoopbackHost(parsedOrigin.hostname) &&
    (isLoopbackHost(requestHostname) || isLoopbackHost(requestForwardedHostname))
  ) {
    return { ok: true };
  }

  return { ok: false, reason: "origin not allowed" };
}
