// Gateway/device Ed25519 identity API backed by canonical shared SQLite state.
import crypto from "node:crypto";
import {
  cacheProcessDeviceIdentity,
  readProcessDeviceIdentity,
} from "./device-identity-process-cache.js";
import {
  assertNoPendingLegacyIdentity,
  generateStoredDeviceIdentity,
  insertStoredDeviceIdentityIfAbsent,
  readStoredDeviceIdentity,
  readStoredDeviceIdentityReadOnly,
  resolveDeviceIdentityStore,
  type DeviceIdentity,
  type DeviceIdentityStoreOptions,
  type StoredDeviceIdentity,
} from "./device-identity-store.js";
import {
  normalizeEd25519PublicKeyBase64Url,
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
  verifyEd25519Signature,
} from "./ed25519-signature.js";
import { pathMayExistSync } from "./path-existence.js";

export type { DeviceIdentity } from "./device-identity-store.js";

function toDeviceIdentity(stored: StoredDeviceIdentity): DeviceIdentity {
  return {
    deviceId: stored.deviceId,
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
}

/** Load a valid canonical identity or atomically create its SQLite row. */
export function loadOrCreateDeviceIdentity(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity {
  const resolved = resolveDeviceIdentityStore(options);
  const resolvedOptions: DeviceIdentityStoreOptions = {
    ...options,
    path: resolved.databasePath,
    identityKey: resolved.identityKey,
  };
  // A downgrade can recreate retired JSON after SQLite migration. Once this profile has
  // a canonical row, keep it authoritative and leave the retired source for Doctor.
  const existing = pathMayExistSync(resolved.databasePath)
    ? readStoredDeviceIdentity(resolvedOptions)
    : null;
  if (existing) {
    return toDeviceIdentity(existing);
  }
  assertNoPendingLegacyIdentity(resolvedOptions);

  // Generate outside the write transaction. The transaction rereads the row
  // before inserting so concurrent runtimes converge on one authoritative key.
  const candidate = generateStoredDeviceIdentity();
  return toDeviceIdentity(insertStoredDeviceIdentityIfAbsent(candidate, resolvedOptions));
}

/** Keep one authoritative identity stable for the lifetime of a state-dir process. */
export function loadOrCreateProcessDeviceIdentity(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity {
  const { databasePath, identityKey } = resolveDeviceIdentityStore(options);
  const cacheKey = `${databasePath}\0${identityKey}`;
  const cached = readProcessDeviceIdentity(cacheKey);
  // A process-stable identity needs no database admission on a warm read.
  if (cached) {
    return cached;
  }
  const identity = loadOrCreateDeviceIdentity({ ...options, path: databasePath, identityKey });
  return cacheProcessDeviceIdentity(cacheKey, identity);
}

/** Load a valid persisted identity without creating or mutating SQLite state. */
export function loadDeviceIdentityIfPresent(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity | null {
  const stored = readStoredDeviceIdentityReadOnly(options);
  if (stored) {
    return toDeviceIdentity(stored);
  }
  assertNoPendingLegacyIdentity(options);
  return null;
}

/** Sign a UTF-8 payload with a PEM Ed25519 private key and return base64url bytes. */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  return signEd25519Payload(privateKeyPem, payload);
}

/** Normalize PEM or raw base64/base64url public keys to canonical raw base64url bytes. */
export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  return normalizeEd25519PublicKeyBase64Url(publicKey);
}

/** Derive the stable device id from PEM or raw base64/base64url public key material. */
export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const normalized = normalizeEd25519PublicKeyBase64Url(publicKey);
    if (!normalized) {
      return null;
    }
    const raw = Buffer.from(normalized, "base64url");
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/** Export a PEM Ed25519 public key as canonical raw base64url bytes. */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return publicKeyRawBase64UrlFromEd25519Pem(publicKeyPem);
}

/** Verify a UTF-8 payload signature against PEM or raw base64/base64url public key material. */
export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  return verifyEd25519Signature({ publicKey, payload, signatureBase64Url });
}
