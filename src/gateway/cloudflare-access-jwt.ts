import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";

type CloudflareAccessJwtConfig = NonNullable<GatewayTrustedProxyConfig["cloudflareAccessJwt"]>;
type KeySet = { keys: Map<string, KeyObject>; fetchedAt: number };

const CERTS_PATH = "/cdn-cgi/access/certs";
const KEY_SET_TTL_MS = 10 * 60_000;
// Access rotates signing keys; an unknown kid refetches at most this often.
const UNKNOWN_KID_REFETCH_MS = 30_000;
const CERTS_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 60;

// Last good key set and in-flight refresh per configured issuer; the certs URL
// depends on nothing else. A failed refresh keeps the last good keys.
const keySets = new Map<string, KeySet>();
const refreshes = new Map<string, Promise<KeySet | undefined>>();

async function fetchKeySet(issuer: string): Promise<KeySet> {
  const response = await fetch(`${issuer}${CERTS_PATH}`, {
    redirect: "error",
    signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cloudflare Access certs request failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const keys = new Map<string, KeyObject>();
  for (const jwk of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
    if (isRecord(jwk) && jwk.kty === "RSA" && typeof jwk.kid === "string") {
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
      } catch {
        // Skip a malformed key; assertions signed by it fail verification.
      }
    }
  }
  return { keys, fetchedAt: Date.now() };
}

function refreshKeySet(issuer: string): Promise<KeySet | undefined> {
  let pending = refreshes.get(issuer);
  if (!pending) {
    pending = fetchKeySet(issuer)
      .then(
        (keySet) => {
          keySets.set(issuer, keySet);
          return keySet;
        },
        () => undefined,
      )
      .finally(() => refreshes.delete(issuer));
    refreshes.set(issuer, pending);
  }
  return pending;
}

/** Returns the key for kid, undefined for an unknown kid, or null when no keys could be loaded. */
async function resolveSigningKey(
  issuer: string,
  kid: string,
): Promise<KeyObject | undefined | null> {
  const cached = keySets.get(issuer);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  const key = cached?.keys.get(kid);
  // Known keys never wait on a refresh that a forged kid triggered.
  if (key ? age < KEY_SET_TTL_MS : age < UNKNOWN_KID_REFETCH_MS) {
    return key;
  }
  const keySet = (await refreshKeySet(issuer)) ?? cached;
  return keySet ? keySet.keys.get(kid) : null;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

type CloudflareAccessJwtResult =
  | { ok: true; email?: string }
  | { ok: false; reason: "invalid" | "keys_unavailable" };

const INVALID = { ok: false, reason: "invalid" } as const;

/**
 * Verify a `cf-access-jwt-assertion` against the team's published keys.
 * Forged, expired, or other-team/application assertions are invalid.
 * Service-token assertions verify without an email.
 */
export async function verifyCloudflareAccessJwt(
  assertion: string,
  config: CloudflareAccessJwtConfig,
): Promise<CloudflareAccessJwtResult> {
  const segments = assertion.trim().split(".");
  if (segments.length !== 3) {
    return INVALID;
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = decodeSegment(encodedHeader);
  const payload = decodeSegment(encodedPayload);
  // Access signs with RS256 only; pinning alg rules out "none" and key-confusion tricks.
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") {
    return INVALID;
  }
  const key = await resolveSigningKey(config.issuer, header.kid);
  if (key === null) {
    return { ok: false, reason: "keys_unavailable" };
  }
  if (
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, "base64url"),
    )
  ) {
    return INVALID;
  }
  const now = Date.now() / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    payload.iss !== config.issuer ||
    !audiences.includes(config.audience) ||
    typeof payload.exp !== "number" ||
    payload.exp + CLOCK_SKEW_SECONDS <= now ||
    (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now)
  ) {
    return INVALID;
  }
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  return email ? { ok: true, email } : { ok: true };
}
