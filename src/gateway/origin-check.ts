import type { AllowedOriginEntry } from "../config/types.gateway.js";
import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "./net.js";

/** Resolved metadata about the matched origin entry (if any). */
export type MatchedOriginInfo = {
  /** Whether this origin entry has `tokenOnlyAuth` enabled. */
  tokenOnlyAuth: boolean;
};

type OriginCheckResult =
  | {
      ok: true;
      matched?: MatchedOriginInfo;
      matchedBy?: "allowlist" | "host-header-fallback" | "local-loopback";
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

/**
 * Normalize an AllowedOriginEntry (string or object) to its origin string
 * and per-origin options.
 */
function normalizeOriginEntry(entry: AllowedOriginEntry): {
  origin: string;
  tokenOnlyAuth: boolean;
} {
  if (typeof entry === "string") {
    return { origin: entry.trim().toLowerCase(), tokenOnlyAuth: false };
  }
  return {
    origin: entry.origin.trim().toLowerCase(),
    tokenOnlyAuth: entry.tokenOnlyAuth === true,
  };
}

export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: AllowedOriginEntry[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const entries = (params.allowedOrigins ?? []).map(normalizeOriginEntry);

  // Check wildcard (allows all origins, no tokenOnlyAuth)
  if (entries.some((e) => e.origin === "*")) {
    return { ok: true, matchedBy: "allowlist" };
  }

  // Check exact origin match (supports tokenOnlyAuth per entry)
  const matched = entries.find((e) => e.origin && e.origin === parsedOrigin.origin);
  if (matched) {
    return {
      ok: true,
      matched: { tokenOnlyAuth: matched.tokenOnlyAuth },
      matchedBy: "allowlist",
    };
  }

  const requestHost = normalizeHostHeader(params.requestHost);
  if (
    params.allowHostHeaderOriginFallback === true &&
    requestHost &&
    parsedOrigin.host === requestHost
  ) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }

  const requestHostname = resolveHostName(requestHost);
  if (isLoopbackHost(parsedOrigin.hostname) && isLoopbackHost(requestHostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  // Dev fallback only for genuinely local socket clients, not Host-header claims.
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true };
  }

  return { ok: false, reason: "origin not allowed" };
}
