import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  readOpenClawStateKvJsonResult,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

const DEVICE_IDENTITY_SCOPE = "identity.device";
const DEVICE_IDENTITY_KEY = "default";
const DEVICE_IDENTITY_PATH_KEY_PREFIX = "path:";

export class DeviceIdentityMigrationRequiredError extends Error {
  constructor(filePath: string) {
    super(
      `Legacy device identity exists at ${filePath} but has not been imported into SQLite. Run "openclaw doctor --fix" before starting the gateway or connecting this client.`,
    );
    this.name = "DeviceIdentityMigrationRequiredError";
  }
}

export class DeviceIdentityStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceIdentityStorageError";
  }
}

function resolveDefaultIdentityPath(): string {
  return path.join(resolveStateDir(), "identity", "device.json");
}

function stateDbOptionsForIdentityPath(filePath: string): { env: NodeJS.ProcessEnv } {
  const resolved = path.resolve(filePath);
  const envStateDir = resolveStateDir(process.env);
  if (resolved.endsWith(path.join("identity", "device.json"))) {
    return {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.dirname(path.dirname(resolved)),
      },
    };
  }
  if (resolved.startsWith(`${path.resolve(envStateDir)}${path.sep}`)) {
    return {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      },
    };
  }
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.dirname(resolved),
    },
  };
}

function identityKeyForPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (resolved.endsWith(path.join("identity", "device.json"))) {
    return DEVICE_IDENTITY_KEY;
  }
  return `${DEVICE_IDENTITY_PATH_KEY_PREFIX}${crypto.createHash("sha256").update(resolved).digest("hex")}`;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
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

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function parseStoredIdentity(value: unknown): StoredDeviceIdentity | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { deviceId?: unknown }).deviceId !== "string" ||
    typeof (value as { publicKeyPem?: unknown }).publicKeyPem !== "string" ||
    typeof (value as { privateKeyPem?: unknown }).privateKeyPem !== "string"
  ) {
    return null;
  }
  return value as StoredDeviceIdentity;
}

function readStoredIdentity(filePath: string): StoredDeviceIdentity | null {
  const result = readOpenClawStateKvJsonResult(
    DEVICE_IDENTITY_SCOPE,
    identityKeyForPath(filePath),
    stateDbOptionsForIdentityPath(filePath),
  );
  if (!result.exists) {
    return null;
  }
  const parsed = parseStoredIdentity(result.value);
  if (!parsed) {
    throw new DeviceIdentityStorageError(
      'Stored device identity is invalid. Run "openclaw doctor --fix" before starting the gateway or connecting this client.',
    );
  }
  return parsed;
}

function readStoredIdentityForEnv(env: NodeJS.ProcessEnv): StoredDeviceIdentity | null {
  const result = readOpenClawStateKvJsonResult(DEVICE_IDENTITY_SCOPE, DEVICE_IDENTITY_KEY, {
    env,
  });
  if (!result.exists) {
    return null;
  }
  return parseStoredIdentity(result.value);
}

function legacyIdentityFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertNoUnimportedLegacyIdentity(filePath: string): void {
  if (legacyIdentityFileExists(filePath)) {
    throw new DeviceIdentityMigrationRequiredError(filePath);
  }
}

function writeStoredIdentity(filePath: string, stored: StoredDeviceIdentity): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    DEVICE_IDENTITY_SCOPE,
    identityKeyForPath(filePath),
    stored as unknown as OpenClawStateJsonValue,
    stateDbOptionsForIdentityPath(filePath),
  );
}

export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  const parsed = readStoredIdentity(filePath);
  if (parsed) {
    const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
    if (derivedId && derivedId !== parsed.deviceId) {
      const updated: StoredDeviceIdentity = {
        ...parsed,
        deviceId: derivedId,
      };
      writeStoredIdentity(filePath, updated);
      return {
        deviceId: derivedId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  }

  assertNoUnimportedLegacyIdentity(filePath);

  const identity = generateIdentity();
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  writeStoredIdentity(filePath, stored);
  return identity;
}

export function loadDeviceIdentityIfPresent(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity | null {
  try {
    const parsed = readStoredIdentity(filePath);
    if (!parsed) {
      return null;
    }
    const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
    if (!derivedId || derivedId !== parsed.deviceId) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  } catch {
    return null;
  }
}

export function loadDeviceIdentityIfPresentForEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeviceIdentity | null {
  try {
    const parsed = readStoredIdentityForEnv(env);
    if (!parsed) {
      return null;
    }
    const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
    if (!derivedId || derivedId !== parsed.deviceId) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  } catch {
    return null;
  }
}

export function parseStoredDeviceIdentitySnapshot(value: unknown): StoredDeviceIdentity | null {
  return parseStoredIdentity(value);
}

export function writeStoredDeviceIdentitySnapshot(
  filePath: string,
  stored: StoredDeviceIdentity,
): void {
  writeStoredIdentity(filePath, stored);
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  try {
    if (publicKey.includes("BEGIN")) {
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

export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const raw = publicKey.includes("BEGIN")
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

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  try {
    const key = publicKey.includes("BEGIN")
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
