// Stores and converts the gateway/device Ed25519 identity.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  base64UrlDecode,
  deriveEd25519PublicKeyRaw,
  ed25519PrivateKeyPemFromRaw,
  ed25519PublicKeyPemFromRaw,
  normalizeEd25519PublicKeyBase64Url,
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
  verifyEd25519Signature,
} from "./ed25519-signature.js";
import { privateFileStoreSync } from "./private-file-store.js";

/** Gateway/device Ed25519 identity used for APNs relay and gateway authentication. */
export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

type StoredSwiftIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

function resolveDefaultIdentityPath(): string {
  return path.join(resolveStateDir(), "identity", "device.json");
}

// Swift stores raw Ed25519 key bytes; Node crypto needs DER/PEM wrappers around them.
const publicKeyPemFromRaw = ed25519PublicKeyPemFromRaw;
const privateKeyPemFromRaw = ed25519PrivateKeyPemFromRaw;

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = deriveEd25519PublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function tryFingerprintPublicKey(publicKeyPem: string): string | null {
  try {
    return fingerprintPublicKey(publicKeyPem);
  } catch {
    return null;
  }
}

function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    const payload = Buffer.from("openclaw-device-identity-self-check", "utf8");
    const signature = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem));
    return crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

type NormalizedStoredIdentity =
  | {
      kind: "identity";
      identity: DeviceIdentity;
      stored?: StoredIdentity;
      validForReadOnly: boolean;
    }
  | { kind: "recognized-invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function hasRecognizedIdentityShape(parsed: unknown): boolean {
  return (
    isRecord(parsed) &&
    ("publicKeyPem" in parsed ||
      "privateKeyPem" in parsed ||
      "publicKey" in parsed ||
      "privateKey" in parsed)
  );
}

function normalizeStoredIdentity(parsed: unknown): NormalizedStoredIdentity | null {
  if (
    isRecord(parsed) &&
    "version" in parsed &&
    parsed.version === 1 &&
    "deviceId" in parsed &&
    typeof parsed.deviceId === "string" &&
    "publicKeyPem" in parsed &&
    typeof parsed.publicKeyPem === "string" &&
    "privateKeyPem" in parsed &&
    typeof parsed.privateKeyPem === "string"
  ) {
    const stored = parsed as StoredIdentity;
    const derivedId = tryFingerprintPublicKey(stored.publicKeyPem);
    if (!derivedId || !keyPairMatches(stored.publicKeyPem, stored.privateKeyPem)) {
      return { kind: "recognized-invalid" };
    }
    const identity = {
      deviceId: derivedId,
      publicKeyPem: stored.publicKeyPem,
      privateKeyPem: stored.privateKeyPem,
    };
    return derivedId === stored.deviceId
      ? { kind: "identity", identity, validForReadOnly: true }
      : {
          kind: "identity",
          identity,
          validForReadOnly: false,
          stored: {
            ...stored,
            deviceId: derivedId,
          },
        };
  }

  if (
    isRecord(parsed) &&
    !("version" in parsed) &&
    "deviceId" in parsed &&
    typeof parsed.deviceId === "string" &&
    "publicKey" in parsed &&
    typeof parsed.publicKey === "string" &&
    "privateKey" in parsed &&
    typeof parsed.privateKey === "string"
  ) {
    const stored = parsed as StoredSwiftIdentity;
    const publicKeyRaw = base64UrlDecode(stored.publicKey);
    const privateKeyRaw = base64UrlDecode(stored.privateKey);
    if (publicKeyRaw.length !== 32 || privateKeyRaw.length !== 32) {
      return { kind: "recognized-invalid" };
    }
    const publicKeyPem = publicKeyPemFromRaw(publicKeyRaw);
    const privateKeyPem = privateKeyPemFromRaw(privateKeyRaw);
    if (!keyPairMatches(publicKeyPem, privateKeyPem)) {
      return { kind: "recognized-invalid" };
    }
    // Migrate the legacy Swift raw-key shape only after the key pair proves valid.
    const derivedId = fingerprintPublicKey(publicKeyPem);
    const validForReadOnly = derivedId === stored.deviceId;
    const migrated: StoredIdentity = {
      version: 1,
      deviceId: derivedId,
      publicKeyPem,
      privateKeyPem,
      createdAtMs:
        typeof stored.createdAtMs === "number" && Number.isFinite(stored.createdAtMs)
          ? stored.createdAtMs
          : Date.now(),
    };
    return {
      kind: "identity",
      identity: {
        deviceId: derivedId,
        publicKeyPem,
        privateKeyPem,
      },
      validForReadOnly,
      stored: migrated,
    };
  }

  return hasRecognizedIdentityShape(parsed) ? { kind: "recognized-invalid" } : null;
}

function identityFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Load a valid persisted identity, repair/migrate when safe, or create a new one. */
export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  try {
    const store = privateFileStoreSync(path.dirname(filePath));
    const parsed = store.readJsonIfExists(path.basename(filePath));
    const normalized = normalizeStoredIdentity(parsed);
    if (normalized?.kind === "identity") {
      if (normalized.stored) {
        try {
          store.writeJson(path.basename(filePath), normalized.stored, {
            trailingNewline: true,
          });
        } catch {
          // Keep using recognized OpenClaw key material even if best-effort normalization fails.
        }
      }
      return normalized.identity;
    }
    if (normalized?.kind === "recognized-invalid") {
      // Avoid overwriting recognizable but invalid identity files; callers can still use a fresh key.
      return generateIdentity();
    }
    if (identityFileExists(filePath)) {
      // Unrecognized existing files may hold a newer schema; never overwrite them either.
      return generateIdentity();
    }
  } catch {
    if (identityFileExists(filePath)) {
      return generateIdentity();
    }
  }

  const identity = generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  privateFileStoreSync(path.dirname(filePath)).writeJson(path.basename(filePath), stored, {
    trailingNewline: true,
  });
  return identity;
}

let processDeviceIdentity: { filePath: string; identity: DeviceIdentity } | undefined;

/**
 * Keep one identity stable for the lifetime of the active state-dir process.
 * Recognizable invalid stores yield transient keys, so independent reloads would split gateway ownership.
 */
export function loadOrCreateProcessDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  if (processDeviceIdentity?.filePath === filePath) {
    return processDeviceIdentity.identity;
  }
  const identity = loadOrCreateDeviceIdentity(filePath);
  processDeviceIdentity = { filePath, identity };
  return identity;
}

/** Load a valid persisted device identity without creating, repairing, or migrating files. */
export function loadDeviceIdentityIfPresent(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity | null {
  try {
    const parsed = privateFileStoreSync(path.dirname(filePath)).readJsonIfExists(
      path.basename(filePath),
    );
    const normalized = normalizeStoredIdentity(parsed);
    if (normalized?.kind !== "identity" || !normalized.validForReadOnly) {
      return null;
    }
    return normalized.identity;
  } catch {
    return null;
  }
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
    const raw = publicKey.includes("BEGIN")
      ? deriveEd25519PublicKeyRaw(publicKey)
      : base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
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
