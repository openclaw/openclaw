import crypto from "node:crypto";
import type { ObaVerificationResult } from "./types.js";
import { base64UrlDecode } from "./base64url.js";
import { CanonicalizeError, preparePayloadForSigning } from "./canonicalize.js";
import { classifyObaOffline } from "./extract.js";
import { validateOwnerUrl } from "./owner-url.js";

type JwkEntry = {
  kty: string;
  crv: string;
  kid: string;
  x: string;
  use?: string;
  alg?: string;
};

// Cache JWKS fetches with TTL to prevent stampede and allow key rotation.
type JwksCacheEntry = {
  promise: Promise<{ keys: JwkEntry[] }>;
  expiresAt: number;
};
const jwksCache = new Map<string, JwksCacheEntry>();

const JWKS_FETCH_TIMEOUT_MS = 3_000;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Fetch JWKS from ownerUrl with a 3s timeout. Caches the promise per URL
 * so concurrent verifications sharing the same owner don't duplicate requests.
 * Successful entries expire after 5 minutes to pick up key rotations.
 */
export function resolveJwks(ownerUrl: string): Promise<{ keys: JwkEntry[] }> {
  const cached = jwksCache.get(ownerUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  // Expired or not cached — remove stale entry.
  if (cached) {
    jwksCache.delete(ownerUrl);
  }

  const promise = fetchJwks(ownerUrl);
  jwksCache.set(ownerUrl, { promise, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });

  // Evict failed fetches so retries can try again.
  // Only delete if the cache entry is still ours (a new fetch may have replaced it).
  promise.catch(() => {
    const current = jwksCache.get(ownerUrl);
    if (current && current.promise === promise) {
      jwksCache.delete(ownerUrl);
    }
  });

  return promise;
}

function isValidJwkEntry(entry: unknown): entry is JwkEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return (
    typeof e.kty === "string" &&
    typeof e.crv === "string" &&
    typeof e.kid === "string" &&
    typeof e.x === "string"
  );
}

const JWKS_MAX_BODY_BYTES = 512 * 1024; // 512 KB

async function fetchJwks(ownerUrl: string): Promise<{ keys: JwkEntry[] }> {
  // Defense-in-depth: validate owner URL even if callers already checked,
  // so resolveJwks (exported) is safe to call directly.
  const urlCheck = validateOwnerUrl(ownerUrl);
  if (!urlCheck.ok) {
    throw new Error(`invalid owner URL: ${urlCheck.error}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    // redirect: "error" prevents SSRF via open-redirect to internal hosts.
    const res = await fetch(ownerUrl, { signal: controller.signal, redirect: "error" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    // Guard against oversized responses (DoS via huge JWKS payload).
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > JWKS_MAX_BODY_BYTES) {
      throw new Error("JWKS response too large");
    }
    const text = await res.text();
    if (text.length > JWKS_MAX_BODY_BYTES) {
      throw new Error("JWKS response too large");
    }
    const body = JSON.parse(text) as { keys?: unknown };
    if (!body || !Array.isArray(body.keys)) {
      throw new Error("invalid JWKS response: missing keys array");
    }
    // Validate individual JWK entries before caching.
    const validKeys = body.keys.filter(isValidJwkEntry);
    return { keys: validKeys };
  } finally {
    clearTimeout(timeout);
  }
}

export function findKeyByKid(keys: JwkEntry[], kid: string): JwkEntry | null {
  return keys.find((k) => k.kid === kid) ?? null;
}

/**
 * Verify an Ed25519 signature against a JWK.
 */
export function verifyObaSignature(payload: Buffer, sigB64Url: string, jwk: JwkEntry): boolean {
  // Validate JWK curve before importing to prevent unexpected key types.
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error(`unsupported JWK: kty=${jwk.kty}, crv=${jwk.crv}`);
  }
  const sigBytes = base64UrlDecode(sigB64Url);
  const publicKey = crypto.createPublicKey({
    key: jwk as unknown as JsonWebKey,
    format: "jwk",
  });
  return crypto.verify(null, payload, publicKey, sigBytes);
}

/**
 * Full verification of a container (plugin manifest or skill metadata root object).
 * Reads container.oba, validates offline, builds payload, fetches JWKS, verifies.
 */
export async function verifyObaContainer(
  container: Record<string, unknown>,
): Promise<ObaVerificationResult> {
  const { oba, verification } = classifyObaOffline(container.oba);

  // Not signed or already invalid => return as-is.
  if (verification.status !== "signed" || !oba) {
    return verification;
  }

  let payload: Buffer;
  try {
    payload = preparePayloadForSigning(container);
  } catch (err) {
    const reason =
      err instanceof CanonicalizeError
        ? `canonicalization failed: ${err.message}`
        : "canonicalization failed";
    return { status: "invalid", ownerUrl: oba.owner, reason };
  }

  let jwks: { keys: JwkEntry[] };
  try {
    jwks = await resolveJwks(oba.owner);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "invalid", ownerUrl: oba.owner, reason: `jwks fetch failed: ${detail}` };
  }

  const key = findKeyByKid(jwks.keys, oba.kid);
  if (!key) {
    return { status: "invalid", ownerUrl: oba.owner, reason: `key not found: kid=${oba.kid}` };
  }

  let valid: boolean;
  try {
    valid = verifyObaSignature(payload, oba.sig, key);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "invalid",
      ownerUrl: oba.owner,
      reason: `signature verification error: ${detail}`,
    };
  }

  if (!valid) {
    return { status: "invalid", ownerUrl: oba.owner, reason: "signature mismatch" };
  }

  return { status: "verified", ownerUrl: oba.owner };
}

/**
 * Concurrency-limited async map. Runs at most `limit` fn calls in parallel.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Clear cached JWKS entries (for testing). */
export function clearJwksCache(): void {
  jwksCache.clear();
}
