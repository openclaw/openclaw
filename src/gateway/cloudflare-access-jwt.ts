import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";

type CloudflareAccessJwtConfig = NonNullable<GatewayTrustedProxyConfig["cloudflareAccessJwt"]>;
type KeySet = { keys: Map<string, KeyObject>; fetchedAt: number };

const CERTS_PATH = "/cdn-cgi/access/certs";
const CERTS_MAX_BYTES = 64 * 1024;
const CERTS_TIMEOUT_MS = 10_000;
const KEY_SET_TTL_MS = 10 * 60_000;
// At most one certs fetch per issuer this often, whether the last one failed or an
// assertion names an unknown kid (Access rotated keys, or a forgery).
const MIN_REFETCH_MS = 30_000;
const CLOCK_SKEW_SECONDS = 60;

// Last good key set, in-flight refresh and last fetch attempt per configured issuer;
// the certs URL depends on nothing else. A failed refresh keeps the last good keys.
const keySets = new Map<string, KeySet>();
const refreshes = new Map<string, Promise<KeySet | undefined>>();
const lastFetchAttempts = new Map<string, number>();

async function fetchKeySet(issuer: string): Promise<KeySet> {
  const response = await fetch(`${issuer}${CERTS_PATH}`, {
    redirect: "error",
    signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cloudflare Access certs request failed: HTTP ${response.status}`);
  }
  const body: unknown = JSON.parse(
    (await readResponseWithLimit(response, CERTS_MAX_BYTES)).toString("utf8"),
  );
  const keys = new Map<string, KeyObject>();
  for (const jwk of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
    if (
      isRecord(jwk) &&
      jwk.kty === "RSA" &&
      typeof jwk.kid === "string" &&
      typeof jwk.n === "string" &&
      typeof jwk.e === "string"
    ) {
      try {
        keys.set(
          jwk.kid,
          createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }),
        );
      } catch {
        // Skip a malformed key; assertions signed by it fail verification.
      }
    }
  }
  return { keys, fetchedAt: Date.now() };
}

/** Returns the key for kid, undefined for an unknown kid, or null when no keys could be loaded. */
async function resolveSigningKey(
  issuer: string,
  kid: string,
): Promise<KeyObject | undefined | null> {
  const cached = keySets.get(issuer);
  const key = cached?.keys.get(kid);
  if (cached && key && Date.now() - cached.fetchedAt < KEY_SET_TTL_MS) {
    return key;
  }
  let pending = refreshes.get(issuer);
  if (!pending) {
    if (Date.now() - (lastFetchAttempts.get(issuer) ?? -Infinity) < MIN_REFETCH_MS) {
      return cached ? key : null;
    }
    lastFetchAttempts.set(issuer, Date.now());
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
  } else if (key) {
    // A known key never waits on a refresh (which a forged kid may have triggered).
    return key;
  }
  const keySet = (await pending) ?? cached;
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
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = assertion.trim().split(".");
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    extra.length > 0
  ) {
    return INVALID;
  }
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
