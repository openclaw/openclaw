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
    // new URL() only understands standard schemes (http, https, ws, wss, etc.).
    // Fall back to manual parsing for custom schemes like tauri:// or electron://.
    return parseCustomSchemeOrigin(trimmed);
  }
}

/** Manual fallback for non-standard URL schemes (tauri://, electron://, etc.). */
function parseCustomSchemeOrigin(
  input: string,
): { origin: string; host: string; hostname: string } | null {
  // Match: scheme://host or scheme://host:port
  const match = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)/);
  if (!match) {
    return null;
  }
  const scheme = match[1].toLowerCase();
  const hostPart = match[2].toLowerCase();
  // Extract hostname (strip port)
  const colonIdx = hostPart.lastIndexOf(":");
  const hostname = colonIdx > 0 ? hostPart.substring(0, colonIdx) : hostPart;
  // Only allow valid hostname characters
  if (!/^[a-zA-Z0-9._-]+$/.test(hostname)) {
    return null;
  }
  return {
    origin: `${scheme}://${hostPart}`,
    host: hostPart,
    hostname,
  };
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
