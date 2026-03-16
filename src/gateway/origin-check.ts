import { createHmac } from "node:crypto";
import { validateProtoMismatch, type ForwardedHeader } from "./forwarded-headers.js";
import { isLoopbackHost, normalizeHostHeader } from "./net.js";

export interface SignedTokenPayload {
  sub: string;
  origin: string;
  iat: number;
  exp: number;
  nonce: string;
}

export type SignedTokenVerificationResult =
  | { ok: true; user: string }
  | { ok: false; reason: string };

const SIGNED_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

export function verifySignedOriginToken(
  token: string,
  sharedSecret: string,
  expectedOrigin: string,
): SignedTokenVerificationResult {
  if (!token || !sharedSecret) {
    return { ok: false, reason: "missing token or secret" };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { ok: false, reason: "invalid token format" };
    }

    const [payloadB64, sigB64] = parts;

    const expectedSig = createHmac("sha256", sharedSecret).update(payloadB64).digest("base64url");

    if (sigB64 !== expectedSig) {
      return { ok: false, reason: "invalid signature" };
    }

    const payload: SignedTokenPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    if (payload.origin.toLowerCase() !== expectedOrigin.toLowerCase()) {
      return { ok: false, reason: "origin mismatch" };
    }

    const now = Date.now();
    const iatMs = payload.iat * 1000;
    if (iatMs > now + 30000 || iatMs < now - SIGNED_TOKEN_MAX_AGE_MS) {
      return { ok: false, reason: "token expired or not yet valid" };
    }

    if (payload.exp && payload.exp * 1000 < now) {
      return { ok: false, reason: "token expired" };
    }

    return { ok: true, user: payload.sub };
  } catch {
    return { ok: false, reason: "token verification failed" };
  }
}

type OriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "host-header-fallback" | "local-loopback";
      wildcardMatched: boolean;
    }
  | { ok: false; reason: string };

type OriginCheckParams = {
  requestHost?: string;
  requestForwardedHost?: string;
  requestForwardedProto?: string;
  origin?: string;
  allowedOrigins?: string[];
  allowHostHeaderOriginFallback?: boolean;
  isLocalClient?: boolean;
  isTrustedProxy?: boolean;
  forwardedHeader?: string | string[];
  strictProtoValidation?: boolean;
  disableLocalhostPrivilege?: boolean;
  validateHostHeader?: boolean;
};

function normalizeOriginToMatchUrlHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    const normalizedHost = normalizeHostToMatchUrlHost(url.host);
    if (!normalizedHost) {
      return null;
    }
    return `${url.protocol.replace(":", "")}://${normalizedHost}`.toLowerCase();
  } catch {
    return null;
  }
}

function parseOrigin(
  originRaw?: string,
): { origin: string; host: string; hostname: string; protocol: string } | null {
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
      protocol: url.protocol.replace(":", "").toLowerCase(),
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
  // If it looks like a host:port without scheme, don't use URL parsing
  // (new URL("gateway.tailnet.ts.net:443") treats hostname as scheme, returning empty host)
  // Instead, strip default HTTPS port (:443) directly
  if (!normalized.includes("://") && /^[a-zA-Z0-9.-]+:\d+$/.test(normalized)) {
    // Strip default ports (:443 for HTTPS, :80 for HTTP) to match URL.host behavior
    return normalized.replace(/:(443|80)$/, "").toLowerCase();
  }
  // Use URL parsing for full URLs with scheme
  try {
    const url = new URL(normalized);
    return url.host.toLowerCase();
  } catch {
    // Fallback: just return the normalized value
    return normalized.toLowerCase();
  }
}

export function checkBrowserOrigin(params: OriginCheckParams): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlistOrigins = (params.allowedOrigins ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const allowlist = new Set(allowlistOrigins);

  const normalizedOrigin = normalizeOriginToMatchUrlHost(parsedOrigin.origin);
  const normalizedAllowlistOrigins = allowlistOrigins
    .map((o) => normalizeOriginToMatchUrlHost(o))
    .filter((o): o is string => o !== null);
  const normalizedAllowlist = new Set(normalizedAllowlistOrigins);

  const requestForwardedHost = normalizeHostToMatchUrlHost(params.requestForwardedHost);

  // Security: If forwarded-host is present but proxy is NOT trusted, reject outright.
  // This prevents attackers from bypassing checks by spoofing X-Forwarded-Host.
  if (requestForwardedHost && params.isTrustedProxy !== true) {
    return { ok: false, reason: "origin not allowed" };
  }

  // Security: When behind a trusted proxy, validate protocol BEFORE allowlist check.
  // Even allowlisted origins must have matching protocol to prevent SSL stripping attacks.
  if (params.isTrustedProxy === true && params.strictProtoValidation !== false) {
    const forwardedProto = extractProtoFromForwardedHeader(params.forwardedHeader);
    const protoValidation = validateProtoMismatch({
      originProto: parsedOrigin.protocol,
      forwardedProto,
      xForwardedProto: params.requestForwardedProto,
    });
    if (!protoValidation.ok) {
      return protoValidation;
    }
  }

  const wildcardMatched = allowlist.has("*");
  const isInAllowlist =
    wildcardMatched ||
    allowlist.has(parsedOrigin.origin) ||
    (normalizedOrigin && normalizedAllowlist.has(normalizedOrigin));

  if (isInAllowlist) {
    const validateHostHeader = params.validateHostHeader === true;
    if (validateHostHeader && parsedOrigin.origin && params.requestHost) {
      const hostNormalized = normalizeHostToMatchUrlHost(params.requestHost);
      if (hostNormalized && hostNormalized !== parsedOrigin.host) {
        const normalizedHostOrigin = `https://${hostNormalized}`;
        const hostInAllowlist =
          normalizedAllowlist.has(normalizedHostOrigin) ||
          allowlist.has(`https://${hostNormalized}`);
        if (!hostInAllowlist) {
          return { ok: false, reason: "host header does not match origin or allowlist" };
        }
      }
    }
    return { ok: true, matchedBy: "allowlist", wildcardMatched };
  }

  if (params.isTrustedProxy === true) {
    if (requestForwardedHost && parsedOrigin.host !== requestForwardedHost) {
      return { ok: false, reason: "origin does not match forwarded host" };
    }

    if (params.allowHostHeaderOriginFallback === true) {
      return { ok: true, matchedBy: "host-header-fallback", wildcardMatched: false };
    }
  }

  const directRequestHost = normalizeHostToMatchUrlHost(params.requestHost);
  if (params.allowHostHeaderOriginFallback === true && parsedOrigin.host === directRequestHost) {
    return { ok: true, matchedBy: "host-header-fallback", wildcardMatched: false };
  }

  if (
    params.disableLocalhostPrivilege !== true &&
    params.isLocalClient &&
    isLoopbackHost(parsedOrigin.hostname)
  ) {
    return { ok: true, matchedBy: "local-loopback", wildcardMatched: false };
  }

  return { ok: false, reason: "origin not allowed" };
}

function extractProtoFromForwardedHeader(
  header: string | string[] | undefined,
): string | undefined {
  if (!header) {
    return undefined;
  }

  const entries = parseForwardedHeaderForProto(header);
  const firstEntry = entries[0];
  return firstEntry?.proto;
}

function parseForwardedHeaderForProto(header: string | string[] | undefined): ForwardedHeader[] {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const entries: ForwardedHeader[] = [];
  const segments = raw.split(/\s*;\s*(?=[a-z]+=)/i);

  for (const segment of segments) {
    const entry: ForwardedHeader = {};
    const regex = /([a-z]+)=(?:"([^"]+)"|([^;,]+))/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(segment)) !== null) {
      const key = match[1].toLowerCase();
      const value = match[2] ?? match[3];

      if (key === "proto") {
        entry.proto = value?.trim().toLowerCase();
      }
    }

    if (entry.proto) {
      entries.push(entry);
    }
  }

  return entries;
}
