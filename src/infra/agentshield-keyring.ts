import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getTrustEnforcementConfig } from "./agentshield-trust-config.js";

/**
 * AgentShield Keyring Verification
 *
 * Loads and verifies publisher keyrings from trust root.
 * Verifies signatures against keyring to ensure the signing key
 * is authorized by the publisher.
 *
 * Keyring structure:
 * - Schema: agentshield.publisher_keyring.v1
 * - keys: [{ key_id, alg, pubkey, status, created_at, retired_at?, revoked_at? }]
 * - Key status: "active", "retired", "revoked"
 */

export const KEYRING_SCHEMA = "agentshield.publisher_keyring.v1";
export const KEYRING_TYPE = "agentshield.publisher_keyring";

export type KeyEntry = {
  key_id: string;
  alg: string;
  pubkey: string;
  status: "active" | "retired" | "revoked";
  created_at: string;
  retired_at?: string | null;
  revoked_at?: string | null;
  revocation_reason?: string;
  notes?: string;
};

export type KeyringPayload = {
  type?: string;
  schema: string;
  publisher_id: string;
  issued_at?: string;
  updated_at?: string;
  keys: KeyEntry[];
  signing?: {
    type: string;
    alg: string;
    pubkey: string;
    sig: string;
  };
};

export type SignedKeyring = {
  payload: KeyringPayload;
  signature: string;
  public_key: string;
};

export type KeyringVerifyResult = {
  ok: boolean;
  reason: string;
  keyId: string | null;
};

// Cache for loaded keyrings by publisher ID
type KeyringCache = {
  path: string;
  mtime: number;
  keyring: KeyringPayload | null;
  verified: boolean;
  verifyError: string | null;
};

const keyringCaches = new Map<string, KeyringCache>();

/**
 * Canonical JSON serialization (matches AgentShield's canonical_json).
 */
function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).toSorted();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Verify an ed25519 signature (hex-encoded) against a payload.
 */
function verifyEd25519Hex(publicKeyHex: string, payload: unknown, signatureHex: string): boolean {
  try {
    const message = Buffer.from(canonicalJson(payload), "utf8");
    const pubKeyRaw = Buffer.from(publicKeyHex, "hex");
    const signature = Buffer.from(signatureHex, "hex");

    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, pubKeyRaw]);

    const key = crypto.createPublicKey({
      key: spki,
      type: "spki",
      format: "der",
    });

    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * Verify a signed keyring.
 */
function verifySignedKeyring(data: SignedKeyring | KeyringPayload): [boolean, string] {
  // Check if this is a signed envelope
  if ("signature" in data && "public_key" in data && "payload" in data) {
    const ok = verifyEd25519Hex(data.public_key, data.payload, data.signature);
    if (!ok) {
      return [false, "invalid signature"];
    }

    const payload = data.payload;
    if (payload.schema !== KEYRING_SCHEMA) {
      return [false, `unexpected schema: ${payload.schema}`];
    }

    // Verify exactly one active key
    const activeKeys = (payload.keys ?? []).filter((k) => k.status === "active");
    if (activeKeys.length !== 1) {
      return [false, `expected 1 active key, found ${activeKeys.length}`];
    }

    return [true, "ok"];
  }

  // Unsigned keyring - validate structure
  if (data.schema !== KEYRING_SCHEMA) {
    return [false, `unexpected schema: ${data.schema}`];
  }

  const activeKeys = (data.keys ?? []).filter((k) => k.status === "active");
  if (activeKeys.length !== 1) {
    return [false, `expected 1 active key, found ${activeKeys.length}`];
  }

  return [true, "ok (unsigned)"];
}

/**
 * Resolve keyring path from trust root + publisher ID.
 */
export function resolveKeyringPath(publisherId: string): string | null {
  const config = getTrustEnforcementConfig();
  if (!config.trustRoot) {
    return null;
  }
  const keyringPath = path.join(config.trustRoot, "publishers", publisherId, "keyring.json");
  return fs.existsSync(keyringPath) ? keyringPath : null;
}

/**
 * Load a keyring from disk with mtime-based caching.
 */
export function loadKeyring(
  publisherId: string,
  keyringPath?: string,
): { keyring: KeyringPayload | null; verified: boolean; error: string | null } {
  const filePath = keyringPath ?? resolveKeyringPath(publisherId);

  if (!filePath) {
    return { keyring: null, verified: false, error: "keyring not found" };
  }

  // Check cache
  const cached = keyringCaches.get(publisherId);
  if (cached && cached.path === filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === cached.mtime) {
        return {
          keyring: cached.keyring,
          verified: cached.verified,
          error: cached.verifyError,
        };
      }
    } catch {
      // File deleted, invalidate
    }
  }

  // Load fresh
  if (!fs.existsSync(filePath)) {
    const cache: KeyringCache = {
      path: filePath,
      mtime: 0,
      keyring: null,
      verified: false,
      verifyError: "keyring file not found",
    };
    keyringCaches.set(publisherId, cache);
    return { keyring: null, verified: false, error: "keyring file not found" };
  }

  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as SignedKeyring | KeyringPayload;

    // Unwrap signed envelope if present
    const keyring = "payload" in data ? data.payload : data;
    const [verified, verifyReason] = verifySignedKeyring(data);

    const cache: KeyringCache = {
      path: filePath,
      mtime: stat.mtimeMs,
      keyring,
      verified,
      verifyError: verified ? null : verifyReason,
    };
    keyringCaches.set(publisherId, cache);

    return {
      keyring,
      verified,
      error: verified ? null : verifyReason,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "parse error";
    const cache: KeyringCache = {
      path: filePath,
      mtime: 0,
      keyring: null,
      verified: false,
      verifyError: error,
    };
    keyringCaches.set(publisherId, cache);
    return { keyring: null, verified: false, error };
  }
}

/**
 * Find a key entry by public key hex.
 */
export function findKeyByPubkey(keyring: KeyringPayload, pubkeyHex: string): KeyEntry | null {
  for (const key of keyring.keys ?? []) {
    if (key.pubkey === pubkeyHex) {
      return key;
    }
  }
  return null;
}

/**
 * Get active keys from a keyring.
 */
export function getActiveKeys(keyring: KeyringPayload): KeyEntry[] {
  return (keyring.keys ?? []).filter((k) => k.status === "active");
}

/**
 * Verify a signed object against a publisher's keyring.
 *
 * Checks:
 * 1. Signature is valid
 * 2. Signing public key appears in keyring
 * 3. Key is not revoked (active or retired OK)
 *
 * @param signedObj - Signed envelope with { payload, signature, public_key }
 * @param expectedType - Expected payload type (e.g., "agentshield.trust_card")
 * @param publisherId - Publisher ID to load keyring for
 */
export function verifyWithKeyring(
  signedObj: { payload: unknown; signature: string; public_key: string },
  expectedType: string,
  publisherId: string,
): KeyringVerifyResult {
  // Step 1: Verify signature
  const payload = signedObj.payload as Record<string, unknown>;
  const ok = verifyEd25519Hex(signedObj.public_key, payload, signedObj.signature);
  if (!ok) {
    return { ok: false, reason: "invalid signature", keyId: null };
  }

  // Check type
  if (payload.type !== expectedType) {
    return {
      ok: false,
      reason: `expected type '${expectedType}', got '${String(payload.type)}'`,
      keyId: null,
    };
  }

  // Step 2: Load keyring
  const { keyring, error } = loadKeyring(publisherId);
  if (!keyring) {
    return { ok: false, reason: error ?? "keyring not found", keyId: null };
  }

  // Step 3: Check signing key is in keyring
  const keyEntry = findKeyByPubkey(keyring, signedObj.public_key);
  if (!keyEntry) {
    return {
      ok: false,
      reason: "signing key not found in publisher keyring",
      keyId: null,
    };
  }

  // Step 4: Check key status (active or retired is OK, revoked is not)
  if (keyEntry.status === "revoked") {
    return {
      ok: false,
      reason: `signing key '${keyEntry.key_id}' is revoked`,
      keyId: keyEntry.key_id,
    };
  }

  return { ok: true, reason: "ok", keyId: keyEntry.key_id };
}

/**
 * Verify a trust card against its publisher's keyring.
 */
export function verifyTrustCardWithKeyring(
  signedTrustCard: { payload: unknown; signature: string; public_key: string },
  publisherId: string,
): KeyringVerifyResult {
  return verifyWithKeyring(signedTrustCard, "agentshield.trust_card", publisherId);
}

/**
 * Clear keyring caches (for testing).
 */
export function clearKeyringCaches(): void {
  keyringCaches.clear();
}

/**
 * Check if a given pubkey is in any loaded keyring and is valid (not revoked).
 */
export function isKeyAuthorized(
  publisherId: string,
  pubkeyHex: string,
): {
  authorized: boolean;
  status: string | null;
  keyId: string | null;
} {
  const { keyring } = loadKeyring(publisherId);
  if (!keyring) {
    return { authorized: false, status: null, keyId: null };
  }

  const keyEntry = findKeyByPubkey(keyring, pubkeyHex);
  if (!keyEntry) {
    return { authorized: false, status: null, keyId: null };
  }

  const authorized = keyEntry.status !== "revoked";
  return {
    authorized,
    status: keyEntry.status,
    keyId: keyEntry.key_id,
  };
}
