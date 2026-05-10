import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  parseStoredDeviceIdentitySnapshot,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
  writeStoredDeviceIdentitySnapshot,
  type StoredDeviceIdentity,
} from "../../../infra/device-identity.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function resolveIdentityPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", "device.json");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function exportRawEd25519PublicKeyPem(publicKey: string): string | null {
  const raw = base64UrlDecode(publicKey);
  if (raw.length !== 32) {
    return null;
  }
  try {
    return crypto
      .createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
        type: "spki",
        format: "der",
      })
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return null;
  }
}

function exportRawEd25519PrivateKeyPem(privateKey: string): string | null {
  const raw = base64UrlDecode(privateKey);
  if (raw.length !== 32) {
    return null;
  }
  try {
    return crypto
      .createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, raw]),
        type: "pkcs8",
        format: "der",
      })
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  } catch {
    return null;
  }
}

function privateKeyMatchesPublicKey(publicKeyPem: string, privateKeyPem: string): boolean {
  const payload = "openclaw-device-identity-doctor-import";
  try {
    return verifyDeviceSignature(publicKeyPem, payload, signDevicePayload(privateKeyPem, payload));
  } catch {
    return false;
  }
}

function isValidStoredIdentity(stored: StoredDeviceIdentity): boolean {
  return privateKeyMatchesPublicKey(stored.publicKeyPem, stored.privateKeyPem);
}

function parseLegacyRawSwiftIdentity(value: unknown): StoredDeviceIdentity | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { deviceId?: unknown }).deviceId !== "string" ||
    typeof (value as { publicKey?: unknown }).publicKey !== "string" ||
    typeof (value as { privateKey?: unknown }).privateKey !== "string"
  ) {
    return null;
  }
  const publicKeyPem = exportRawEd25519PublicKeyPem((value as { publicKey: string }).publicKey);
  const privateKeyPem = exportRawEd25519PrivateKeyPem((value as { privateKey: string }).privateKey);
  if (!publicKeyPem || !privateKeyPem || !privateKeyMatchesPublicKey(publicKeyPem, privateKeyPem)) {
    return null;
  }
  return {
    version: 1,
    deviceId: (value as { deviceId: string }).deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs:
      typeof (value as { createdAtMs?: unknown }).createdAtMs === "number"
        ? (value as { createdAtMs: number }).createdAtMs
        : Date.now(),
  };
}

function parseLegacyDeviceIdentity(value: unknown): StoredDeviceIdentity | null {
  const stored = parseStoredDeviceIdentitySnapshot(value);
  if (stored) {
    return isValidStoredIdentity(stored) ? stored : null;
  }
  const rawSwift = parseLegacyRawSwiftIdentity(value);
  if (!rawSwift) {
    return null;
  }
  const rawPublicKey = publicKeyRawBase64UrlFromPem(rawSwift.publicKeyPem);
  if (
    (value as { publicKey: string }).publicKey
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "") !== rawPublicKey
  ) {
    return null;
  }
  return rawSwift;
}

export function legacyDeviceIdentityFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(resolveIdentityPathForEnv(env));
  } catch {
    return false;
  }
}

export function importLegacyDeviceIdentityFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
} {
  const filePath = resolveIdentityPathForEnv(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false };
    }
    throw error;
  }
  const stored = parseLegacyDeviceIdentity(parsed);
  if (!stored) {
    return { imported: false };
  }
  writeStoredDeviceIdentitySnapshot(filePath, stored);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true };
}
