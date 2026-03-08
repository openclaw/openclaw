import { isLoopbackHost, normalizeHostHeader } from "./net.js";

type OriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "host-header-fallback" | "local-loopback";
    }
  | { ok: false; reason: string };

function normalizeOriginForMatch(url: URL): string {
  const normalizedOrigin = url.origin.toLowerCase();
  if (normalizedOrigin !== "null") {
    return normalizedOrigin;
  }
  // Non-standard schemes like chrome-extension://<id> stringify to origin === "null",
  // but still have a stable scheme + host that operators can allowlist exactly.
  return `${url.protocol}//${url.host}`.toLowerCase();
}

function parseOrigin(
  originRaw?: string,
): { matchOrigin: string; host: string; hostname: string } | null {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return {
      matchOrigin: normalizeOriginForMatch(url),
      host: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function normalizeAllowedOrigin(originRaw: string): string | null {
  const trimmed = originRaw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return parseOrigin(trimmed)?.matchOrigin ?? null;
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
    (params.allowedOrigins ?? []).map(normalizeAllowedOrigin).filter(Boolean),
  );
  if (allowlist.has("*") || allowlist.has(parsedOrigin.matchOrigin)) {
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
