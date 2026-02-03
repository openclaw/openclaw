import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

type EncryptedEnvelopeV1 = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type EncryptedEnvelope = EncryptedEnvelopeV1;

const MASTER_KEY_FILENAME = "master.key";
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * Compute a short hash of the master key for tracking in envelopes.
 * This allows detection of which key encrypted a file without exposing the key.
 */
function computeKeyId(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return false;
  }
  return (
    typeof record.nonce === "string" &&
    typeof record.ciphertext === "string" &&
    typeof record.tag === "string"
    // keyId and algorithm are optional for backwards compatibility with early v1 files
  );
}

export function detectJsonFileEncryption(
  pathname: string,
): "encrypted" | "plaintext" | "missing" | "invalid" {
  if (!fs.existsSync(pathname)) {
    return "missing";
  }
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    if (!raw.trim()) {
      return "invalid";
    }
    const parsed = JSON.parse(raw) as unknown;
    return isEncryptedEnvelope(parsed) ? "encrypted" : "plaintext";
  } catch {
    return "invalid";
  }
}

function resolveMasterKeyPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, MASTER_KEY_FILENAME);
}

function ensureStateDir(stateDir: string) {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
}

export function loadOrCreateMasterKey(stateDir: string = resolveStateDir()): Buffer {
  ensureStateDir(stateDir);
  const keyPath = resolveMasterKeyPath(stateDir);
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    if (raw.length !== MASTER_KEY_BYTES) {
      throw new Error("invalid master key length");
    }
    return raw;
  }
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return key;
}

export function encryptJson(data: unknown, key: Buffer): EncryptedEnvelopeV1 {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(data));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: computeKeyId(key),
    nonce: nonce.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decryptJson(envelope: EncryptedEnvelope, key: Buffer): unknown {
  // Version check for future-proofing (currently only v1 exists)
  const version = envelope.version as number;
  if (version !== 1) {
    throw new Error(`unsupported envelope version: ${version}`);
  }
  const nonce = Buffer.from(envelope.nonce, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export function loadSecureJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isEncryptedEnvelope(parsed)) {
      const key = loadOrCreateMasterKey();
      return decryptJson(parsed, key);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveSecureJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const key = loadOrCreateMasterKey();
  const encrypted = encryptJson(data, key);
  // Set mode on write + chmod after to guarantee permissions regardless of umask
  fs.writeFileSync(pathname, `${JSON.stringify(encrypted, null, 2)}\n`, {
    mode: 0o600,
    encoding: "utf8",
  });
  fs.chmodSync(pathname, 0o600);
}

export function migratePlaintextJsonFile(pathname: string): boolean {
  if (!fs.existsSync(pathname)) {
    return false;
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (isEncryptedEnvelope(parsed)) {
    return false;
  }
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const key = loadOrCreateMasterKey();
  const encrypted = encryptJson(parsed, key);
  const tempPath = `${pathname}.tmp`;
  const backupPath = `${pathname}.bak`;
  try {
    // Set mode on write + chmod after to guarantee permissions regardless of umask
    fs.writeFileSync(tempPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(pathname, backupPath);
    fs.renameSync(tempPath, pathname);
    fs.chmodSync(pathname, 0o600);
    fs.unlinkSync(backupPath);
    return true;
  } catch {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup errors
    }
    try {
      if (!fs.existsSync(pathname) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, pathname);
      }
    } catch {
      // ignore restore errors
    }
    return false;
  }
}
