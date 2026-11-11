import crypto from "node:crypto";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import {
  deriveCanonicalEd25519PrivateKeyRaw,
  deriveCanonicalEd25519PublicKeyRaw,
} from "./ed25519-signature.js";

const PRIMARY_DEVICE_IDENTITY_KEY = "primary";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type StoredDeviceIdentity = DeviceIdentity & {
  createdAtMs: number;
};

type DeviceIdentityRow = ClientCredentialDatabase["device_identities"];
type DeviceIdentityInsert = DeviceIdentityRow;

export class DeviceIdentityStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceIdentityStorageError";
  }
}

export function normalizeIdentityKey(key: string | undefined): string {
  const normalized = key ?? PRIMARY_DEVICE_IDENTITY_KEY;
  if (normalized.length === 0 || normalized !== normalized.trim()) {
    throw new DeviceIdentityStorageError(
      "Device identity key must be a non-empty string without surrounding whitespace.",
    );
  }
  if (normalized.length > 128) {
    throw new DeviceIdentityStorageError("Device identity key exceeds 128 characters.");
  }
  return normalized;
}

function invalidStoredIdentityError(
  identityKey: string,
  cause?: unknown,
): DeviceIdentityStorageError {
  return new DeviceIdentityStorageError(
    `SQLite contains an invalid persisted device identity "${identityKey}". Run "openclaw doctor --fix" before starting the gateway or connecting this client.`,
    cause === undefined ? undefined : { cause },
  );
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = deriveCanonicalEd25519PublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Generate canonical Ed25519 material before entering a synchronous write transaction. */
export function generateStoredDeviceIdentity(now = Date.now()): StoredDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: now,
  };
}

function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    deriveCanonicalEd25519PublicKeyRaw(publicKeyPem);
    deriveCanonicalEd25519PrivateKeyRaw(privateKeyPem);
    return (
      crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }) === publicKeyPem
    );
  } catch {
    return false;
  }
}

function parseCreatedAtMs(value: unknown): number | null {
  return asSafeIntegerInRange(value, { min: 0 }) ?? null;
}

/** Validate persisted key material and return the canonical runtime shape. */
export function validateStoredDeviceIdentity(
  value: StoredDeviceIdentity,
  identityKey = PRIMARY_DEVICE_IDENTITY_KEY,
): DeviceIdentity {
  try {
    if (
      !value.deviceId ||
      !/^[a-f0-9]{64}$/.test(value.deviceId) ||
      !value.publicKeyPem ||
      !value.privateKeyPem ||
      parseCreatedAtMs(value.createdAtMs) === null ||
      !keyPairMatches(value.publicKeyPem, value.privateKeyPem)
    ) {
      throw invalidStoredIdentityError(identityKey);
    }
    const derivedDeviceId = fingerprintPublicKey(value.publicKeyPem);
    if (derivedDeviceId !== value.deviceId) {
      throw invalidStoredIdentityError(identityKey);
    }
    return {
      deviceId: value.deviceId,
      publicKeyPem: value.publicKeyPem,
      privateKeyPem: value.privateKeyPem,
    };
  } catch (error) {
    if (error instanceof DeviceIdentityStorageError) {
      throw error;
    }
    throw invalidStoredIdentityError(identityKey, error);
  }
}

export function storedDeviceIdentityFromRow(
  row: DeviceIdentityRow,
  expectedIdentityKey: string,
): StoredDeviceIdentity {
  if (
    row.identity_key !== expectedIdentityKey ||
    typeof row.device_id !== "string" ||
    typeof row.public_key_pem !== "string" ||
    typeof row.private_key_pem !== "string" ||
    parseCreatedAtMs(row.created_at_ms) === null ||
    parseCreatedAtMs(row.updated_at_ms) === null
  ) {
    throw invalidStoredIdentityError(expectedIdentityKey);
  }
  const stored = {
    deviceId: row.device_id,
    publicKeyPem: row.public_key_pem,
    privateKeyPem: row.private_key_pem,
    createdAtMs: row.created_at_ms,
  };
  validateStoredDeviceIdentity(stored, expectedIdentityKey);
  return stored;
}

export function salvageStoredIdentityRow(
  row: DeviceIdentityRow,
  expectedIdentityKey: string,
  repairedAtMs: number,
): StoredDeviceIdentity | null {
  // Device ids, timestamps, and PEM framing are repairable metadata. Preserve matching
  // Ed25519 key bytes because rotating them would invalidate pairing and stored auth.
  if (
    row.identity_key !== expectedIdentityKey ||
    typeof row.public_key_pem !== "string" ||
    typeof row.private_key_pem !== "string"
  ) {
    return null;
  }
  try {
    const publicKey = crypto.createPublicKey(row.public_key_pem);
    const privateKey = crypto.createPrivateKey(row.private_key_pem);
    if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519") {
      return null;
    }
    const canonicalPublicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const canonicalPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const derivedPublicKeyPem = crypto
      .createPublicKey(canonicalPrivateKeyPem)
      .export({ type: "spki", format: "pem" });
    if (derivedPublicKeyPem !== canonicalPublicKeyPem) {
      return null;
    }
    const createdAtMs =
      parseCreatedAtMs(row.created_at_ms) ?? parseCreatedAtMs(row.updated_at_ms) ?? repairedAtMs;
    const salvaged = {
      deviceId: fingerprintPublicKey(canonicalPublicKeyPem),
      publicKeyPem: canonicalPublicKeyPem,
      privateKeyPem: canonicalPrivateKeyPem,
      createdAtMs,
    };
    validateStoredDeviceIdentity(salvaged, expectedIdentityKey);
    return salvaged;
  } catch {
    return null;
  }
}

export function storedDeviceIdentityToRow(
  identityKey: string,
  stored: StoredDeviceIdentity,
  updatedAtMs = stored.createdAtMs,
): DeviceIdentityInsert {
  return {
    identity_key: identityKey,
    device_id: stored.deviceId,
    public_key_pem: stored.publicKeyPem,
    private_key_pem: stored.privateKeyPem,
    created_at_ms: stored.createdAtMs,
    updated_at_ms: updatedAtMs,
  };
}
