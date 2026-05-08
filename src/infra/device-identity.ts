import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

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

const DEVICE_IDENTITY_SCOPE = "identity.device";
const DEVICE_IDENTITY_KEY = "default";
const DEVICE_IDENTITY_PATH_KEY_PREFIX = "path:";

function resolveDefaultIdentityPath(): string {
  return path.join(resolveStateDir(), "identity", "device.json");
}

function resolveIdentityPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", "device.json");
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
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

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

function publicKeyPemFromRaw(publicKeyRaw: Buffer): string {
  return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}

function privateKeyPemFromRaw(privateKeyRaw: Buffer): string {
  return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function parseStoredIdentity(value: unknown): StoredIdentity | null {
  if (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.deviceId === "string" &&
    typeof value.publicKeyPem === "string" &&
    typeof value.privateKeyPem === "string"
  ) {
    return value as StoredIdentity;
  }

  if (
    isRecord(value) &&
    !("version" in value) &&
    typeof value.deviceId === "string" &&
    typeof value.publicKey === "string" &&
    typeof value.privateKey === "string"
  ) {
    const stored = value as StoredSwiftIdentity;
    const publicKeyRaw = base64UrlDecode(stored.publicKey);
    const privateKeyRaw = base64UrlDecode(stored.privateKey);
    if (publicKeyRaw.length !== 32 || privateKeyRaw.length !== 32) {
      return null;
    }
    const publicKeyPem = publicKeyPemFromRaw(publicKeyRaw);
    const privateKeyPem = privateKeyPemFromRaw(privateKeyRaw);
    if (!keyPairMatches(publicKeyPem, privateKeyPem)) {
      return null;
    }
    return {
      version: 1,
      deviceId: fingerprintPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAtMs:
        typeof stored.createdAtMs === "number" && Number.isFinite(stored.createdAtMs)
          ? stored.createdAtMs
          : Date.now(),
    };
  }

  return null;
}

function readStoredIdentity(filePath: string): StoredIdentity | null {
  return parseStoredIdentity(
    readOpenClawStateKvJson(
      DEVICE_IDENTITY_SCOPE,
      identityKeyForPath(filePath),
      stateDbOptionsForIdentityPath(filePath),
    ),
  );
}

function readStoredIdentityForEnv(env: NodeJS.ProcessEnv): StoredIdentity | null {
  return parseStoredIdentity(
    readOpenClawStateKvJson(DEVICE_IDENTITY_SCOPE, DEVICE_IDENTITY_KEY, { env }),
  );
}

function writeStoredIdentity(filePath: string, stored: StoredIdentity): void {
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
  try {
    const parsed = readStoredIdentity(filePath);
    if (parsed) {
      const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
      if (derivedId && derivedId !== parsed.deviceId) {
        const updated: StoredIdentity = {
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
  } catch {
    // fall through to regenerate
  }

  const identity = generateIdentity();
  const stored: StoredIdentity = {
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
  const stored = parseStoredIdentity(parsed);
  if (!stored) {
    return { imported: false };
  }
  writeStoredIdentity(filePath, stored);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true };
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
