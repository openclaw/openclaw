// Stores and converts the gateway/device Ed25519 identity.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
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

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export const ED25519_RAW_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

// Hard input-length caps applied before any crypto parsing. PEM-wrapped
// Ed25519 SPKI is ~120 chars; raw base64url is 43 chars. 1024 chars covers
// every valid Ed25519 form with comfortable margin while bounding the work
// an attacker can force by sending oversized strings into createPublicKey.
export const MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS = 1024;
// Base64url-encoded 64-byte signature is 86 chars (88 with padding).
// 256 covers any plausible encoding without paying for arbitrary input.
export const MAX_DEVICE_SIGNATURE_INPUT_CHARS = 256;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function pemEncode(label: "PUBLIC KEY" | "PRIVATE KEY", der: Buffer): string {
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// Swift stores raw Ed25519 key bytes; Node crypto needs DER/PEM wrappers around them.
function publicKeyPemFromRaw(publicKeyRaw: Buffer): string {
  return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}

function privateKeyPemFromRaw(privateKeyRaw: Buffer): string {
  return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
}

function looksLikePemPublicKey(input: string): boolean {
  return input.includes("BEGIN");
}

// Returns true when `input` could plausibly decode to a valid Ed25519 public
// key. Bounds the input length cheaply and validates the raw byte count for
// the base64url path. The PEM path is only length-bounded here; full ASN.1
// validation is left to crypto.createPublicKey.
export function isPlausibleDevicePublicKeyInput(input: unknown): input is string {
  if (typeof input !== "string") {
    return false;
  }
  const length = input.length;
  if (length === 0 || length > MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS) {
    return false;
  }
  if (looksLikePemPublicKey(input)) {
    return true;
  }
  const raw = base64UrlDecode(input);
  return raw.length === ED25519_RAW_PUBLIC_KEY_BYTES;
}

// Returns true when `input` could plausibly decode to a 64-byte Ed25519
// signature. Mirrors verifyDeviceSignature's base64url-then-base64 fallback
// so the cheap pre-check accepts every input the slow path would have.
export function isPlausibleDeviceSignatureInput(input: unknown): input is string {
  if (typeof input !== "string") {
    return false;
  }
  const length = input.length;
  if (length === 0 || length > MAX_DEVICE_SIGNATURE_INPUT_CHARS) {
    return false;
  }
  if (base64UrlDecode(input).length === ED25519_SIGNATURE_BYTES) {
    return true;
  }
  return Buffer.from(input, "base64").length === ED25519_SIGNATURE_BYTES;
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
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
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

/** Normalize PEM or raw base64/base64url public keys to canonical raw base64url bytes. */
export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  if (!isPlausibleDevicePublicKeyInput(publicKey)) {
    return null;
  }
  try {
    if (looksLikePemPublicKey(publicKey)) {
      return base64UrlEncode(derivePublicKeyRaw(publicKey));
    }
    const raw = base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
    return base64UrlEncode(raw);
  } catch {
    return null;
  }
}

/** Derive the stable device id from PEM or raw base64/base64url public key material. */
export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  if (!isPlausibleDevicePublicKeyInput(publicKey)) {
    return null;
  }
  try {
    const raw = looksLikePemPublicKey(publicKey)
      ? derivePublicKeyRaw(publicKey)
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
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

/** Verify a UTF-8 payload signature against PEM or raw base64/base64url public key material. */
export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  // Cheap shape pre-check: reject malformed public keys / signatures before
  // crypto.createPublicKey or crypto.verify get a chance to do real work.
  // This denies the pre-auth Ed25519-verify CPU-amplification attack where
  // an unauthenticated attacker can otherwise force one full key-parse plus
  // verify per handshake (and the v3-then-v2 fallback doubles that).
  if (
    !isPlausibleDevicePublicKeyInput(publicKey) ||
    !isPlausibleDeviceSignatureInput(signatureBase64Url)
  ) {
    return false;
  }
  try {
    const key = looksLikePemPublicKey(publicKey)
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
          type: "spki",
          format: "der",
        });
    const sig = (() => {
      try {
        return base64UrlDecode(signatureBase64Url);
      } catch {
        return Buffer.from(signatureBase64Url, "base64");
      }
    })();
    return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}
