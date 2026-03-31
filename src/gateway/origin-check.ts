import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "./net.js";

type BrowserRequestCheckResult =
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

function parseAllowedOriginHosts(allowedOrigins?: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const value of allowedOrigins ?? []) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      hosts.add("*");
      continue;
    }
    const parsed = parseOrigin(trimmed);
    if (!parsed) {
      continue;
    }
    // URL.host omits default ports, so an allowlist entry like
    // https://control.example.com will not match Host: control.example.com:443.
    // Keep this aligned with the existing origin-based matching behavior.
    hosts.add(parsed.host);
  }
  return hosts;
}

export function checkBrowserRequestHost(params: {
  requestHost?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
}): BrowserRequestCheckResult {
  const requestHost = normalizeHostHeader(params.requestHost);
  if (!requestHost) {
    return { ok: false, reason: "host missing or invalid" };
  }

  const allowlistHosts = parseAllowedOriginHosts(params.allowedOrigins);
  if (allowlistHosts.has("*") || allowlistHosts.has(requestHost)) {
    return { ok: true, matchedBy: "allowlist" };
  }

  if (params.allowHostHeaderOriginFallback === true) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }

  const hostname = resolveHostName(requestHost);
  if (hostname && isLoopbackHost(hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }

  return { ok: false, reason: "host not allowed" };
}

export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
}): BrowserRequestCheckResult {
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
