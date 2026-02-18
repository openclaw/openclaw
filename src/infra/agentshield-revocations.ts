import crypto from "node:crypto";
import fs from "node:fs";
import { getTrustEnforcementConfig } from "./agentshield-trust-config.js";

/**
 * AgentShield Revocations Loader
 *
 * Loads and caches revocation lists from trust root.
 * Supports signed revocation lists with ed25519 verification.
 *
 * Revocation list structure:
 * - Signed envelope: { payload, signature, public_key }
 * - Payload: { type, schema, issued_at, publisher_id, revocations: [...], signing }
 * - Each revocation: { kind, id, reason, revoked_at, expires_at? }
 *
 * Valid kinds: badge, trust_card, skill_attestation, skill_entry, pubkey, approval_grant
 */

export type RevocationEntry = {
  kind: string;
  id: string;
  reason: string;
  revoked_at: string;
  expires_at?: string | null;
};

export type RevocationListPayload = {
  type: string;
  schema: string;
  issued_at: string;
  publisher_id: string;
  revocations: RevocationEntry[];
  signing?: {
    type: string;
    alg: string;
    pubkey: string;
    sig: string;
  };
};

export type SignedRevocationList = {
  payload: RevocationListPayload;
  signature: string;
  public_key: string;
};

export type RevocationCheckResult = {
  revoked: boolean;
  entry: RevocationEntry | null;
  reason: string | null;
};

// Cache for loaded revocations
type RevocationsCache = {
  path: string;
  mtime: number;
  data: SignedRevocationList | RevocationListPayload | null;
  verified: boolean;
  verifyError: string | null;
};

let revocationsCache: RevocationsCache | null = null;

/**
 * Canonical JSON serialization (matches AgentShield's canonical_json).
 * Sorts keys recursively and uses compact separators.
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

    // Build SPKI-wrapped public key for node:crypto
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
 * Verify a signed revocation list.
 * Returns [ok, reason].
 */
export function verifyRevocationList(
  data: SignedRevocationList | RevocationListPayload,
): [boolean, string] {
  // Check if this is a signed envelope
  if ("signature" in data && "public_key" in data && "payload" in data) {
    const ok = verifyEd25519Hex(data.public_key, data.payload, data.signature);
    if (!ok) {
      return [false, "invalid signature"];
    }

    // Verify payload structure
    const payload = data.payload;
    if (payload.type !== "agentshield.revocations") {
      return [false, `unexpected type: ${payload.type}`];
    }
    if (!payload.schema?.startsWith("agentshield.revocation_list.")) {
      return [false, `unexpected schema: ${payload.schema}`];
    }
    return [true, "ok"];
  }

  // Unsigned revocation list - just validate structure
  if (data.type !== "agentshield.revocations") {
    return [false, `unexpected type: ${data.type}`];
  }
  return [true, "ok (unsigned)"];
}

/**
 * Load revocations list from disk with mtime-based caching.
 */
export function loadRevocations(revocationsPath?: string): {
  data: SignedRevocationList | RevocationListPayload | null;
  verified: boolean;
  error: string | null;
} {
  const config = getTrustEnforcementConfig();
  const filePath = revocationsPath ?? config.revocationsFile;

  if (!filePath) {
    return { data: null, verified: false, error: "no revocations file configured" };
  }

  // Check cache validity
  if (revocationsCache && revocationsCache.path === filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === revocationsCache.mtime) {
        return {
          data: revocationsCache.data,
          verified: revocationsCache.verified,
          error: revocationsCache.verifyError,
        };
      }
    } catch {
      // File may have been deleted, invalidate cache
    }
  }

  // Load fresh
  if (!fs.existsSync(filePath)) {
    revocationsCache = {
      path: filePath,
      mtime: 0,
      data: null,
      verified: false,
      verifyError: "revocations file not found",
    };
    return { data: null, verified: false, error: "revocations file not found" };
  }

  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as SignedRevocationList | RevocationListPayload;

    const [verified, verifyReason] = verifyRevocationList(data);

    revocationsCache = {
      path: filePath,
      mtime: stat.mtimeMs,
      data,
      verified,
      verifyError: verified ? null : verifyReason,
    };

    return {
      data,
      verified,
      error: verified ? null : verifyReason,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "parse error";
    revocationsCache = {
      path: filePath,
      mtime: 0,
      data: null,
      verified: false,
      verifyError: error,
    };
    return { data: null, verified: false, error };
  }
}

/**
 * Check if a (kind, id) is revoked.
 *
 * @param kind - Revocation kind (badge, trust_card, skill_attestation, skill_entry, pubkey, approval_grant)
 * @param id - Identifier to check (varies by kind - could be content_sha256, pubkey, entry id)
 * @returns RevocationCheckResult with revoked status, entry if found, and reason
 */
export function isRevoked(kind: string, id: string): RevocationCheckResult {
  const { data, error } = loadRevocations();

  if (!data) {
    return { revoked: false, entry: null, reason: error };
  }

  // Get revocations array from payload
  const payload = "payload" in data ? data.payload : data;
  const revocations = payload.revocations ?? [];

  for (const entry of revocations) {
    if (entry.kind === kind && entry.id === id) {
      // Check if revocation has expired
      if (entry.expires_at) {
        const expiresAt = new Date(entry.expires_at);
        if (expiresAt < new Date()) {
          continue; // This revocation has expired
        }
      }
      return {
        revoked: true,
        entry,
        reason: entry.reason,
      };
    }
  }

  return { revoked: false, entry: null, reason: null };
}

/**
 * Check if a publisher is revoked (by pubkey or id).
 */
export function isPublisherRevoked(publisherIdOrPubkey: string): RevocationCheckResult {
  return isRevoked("pubkey", publisherIdOrPubkey);
}

/**
 * Check if a trust card is revoked.
 */
export function isTrustCardRevoked(trustCardId: string): RevocationCheckResult {
  return isRevoked("trust_card", trustCardId);
}

/**
 * Check if a skill attestation is revoked.
 */
export function isSkillAttestationRevoked(contentSha256: string): RevocationCheckResult {
  return isRevoked("skill_attestation", contentSha256);
}

/**
 * Clear the revocations cache (for testing).
 */
export function clearRevocationsCache(): void {
  revocationsCache = null;
}

/**
 * Get all current revocations.
 */
export function listRevocations(): RevocationEntry[] {
  const { data } = loadRevocations();
  if (!data) {
    return [];
  }
  const payload = "payload" in data ? data.payload : data;
  return payload.revocations ?? [];
}
