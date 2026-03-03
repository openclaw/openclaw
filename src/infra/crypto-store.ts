import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createKeychainBackend } from "./keychain.js";

type EncryptedEnvelopeV1 = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type EncryptedEnvelope = EncryptedEnvelopeV1;

/**
 * Result type for loadSecureJsonFile to distinguish between:
 * - missing: file doesn't exist (normal, return undefined)
 * - success: file loaded and decrypted successfully
 * - error: file exists but failed to decrypt (should NOT silently lose data)
 */
export type SecureLoadResult =
  | { status: "missing" }
  | { status: "success"; data: unknown }
  | { status: "error"; reason: string; recoverable: boolean };

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
  const service = "com.openclaw.master-key";
  const account = "openclaw";
  const backend = createKeychainBackend();

  // 1. Try keychain backend
  if (backend.isAvailable()) {
    try {
      const existing = backend.get(service, account);
      if (existing && existing.length === MASTER_KEY_BYTES) {
        return existing;
      }
    } catch {
      // Fall through to file/generate if keychain fails
    }
  }

  // 2. Not in keychain, check file (migration or legacy)
  ensureStateDir(stateDir);
  const keyPath = resolveMasterKeyPath(stateDir);
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    if (raw.length !== MASTER_KEY_BYTES) {
      throw new Error("invalid master key length");
    }

    // Migration: Move to keychain if available
    if (backend.isAvailable()) {
      try {
        backend.set(service, account, raw);
        fs.unlinkSync(keyPath);
        console.info("master key migrated from disk to OS keychain");
      } catch (err) {
        console.warn(
          `Failed to migrate master key to keychain: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return raw;
  }

  // 3. Neither exists, generate new key
  const key = crypto.randomBytes(MASTER_KEY_BYTES);

  if (backend.isAvailable()) {
    try {
      backend.set(service, account, key);
      return key;
    } catch (err) {
      console.warn(
        `Failed to store new master key in keychain: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall back to file if keychain set fails
    }
  } else {
    console.info("OS keychain not available, using file-based master key");
  }

  // Fallback to file-based behavior
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

/**
 * Try to recover from a previous interrupted migration by checking for .bak file.
 * If the main file is missing but .bak exists, restore from backup.
 */
function tryRecoverFromBackup(pathname: string): boolean {
  const backupPath = `${pathname}.bak`;
  if (!fs.existsSync(pathname) && fs.existsSync(backupPath)) {
    try {
      fs.renameSync(backupPath, pathname);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Load a JSON file that may be encrypted.
 * Returns a result object to distinguish between missing files and decryption failures.
 * This prevents silent credential loss when decryption fails.
 */
export function loadSecureJsonFileWithResult(pathname: string): SecureLoadResult {
  // First, try to recover from a previous interrupted migration
  tryRecoverFromBackup(pathname);

  if (!fs.existsSync(pathname)) {
    return { status: "missing" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (err) {
    return {
      status: "error",
      reason: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      status: "error",
      reason: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: false,
    };
  }

  if (!isEncryptedEnvelope(parsed)) {
    // Plaintext file, return as-is
    return { status: "success", data: parsed };
  }

  // Encrypted file, attempt decryption
  try {
    const key = loadOrCreateMasterKey();
    const decrypted = decryptJson(parsed, key);
    return { status: "success", data: decrypted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Check if this is a key mismatch (auth tag failure)
    const isKeyMismatch =
      message.includes("Unsupported state") || message.includes("authentication tag");
    return {
      status: "error",
      reason: isKeyMismatch
        ? "Decryption failed: wrong key or corrupted file. Your credentials may be encrypted with a different master key."
        : `Decryption failed: ${message}`,
      recoverable: isKeyMismatch,
    };
  }
}

/**
 * Load a JSON file that may be encrypted.
 * For backwards compatibility, returns undefined on missing or error.
 */
export function loadSecureJsonFile(pathname: string): unknown {
  const result = loadSecureJsonFileWithResult(pathname);
  return result.status === "success" ? result.data : undefined;
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

/**
 * Migrate a plaintext JSON file to encrypted format.
 * Uses atomic operations with backup recovery to prevent data loss on crash.
 */
export function migratePlaintextJsonFile(pathname: string): boolean {
  // First, try to recover from a previous interrupted migration
  tryRecoverFromBackup(pathname);
  const tempPath = `${pathname}.tmp`;
  const backupPath = `${pathname}.bak`;

  if (!fs.existsSync(pathname)) {
    return false;
  }

  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch {
    // ignore cleanup errors
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
  try {
    // Step 1: Write encrypted content to temp file
    fs.writeFileSync(tempPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    fs.chmodSync(tempPath, 0o600);

    // Step 2: Backup original (if interrupted here, tryRecoverFromBackup will restore)
    fs.renameSync(pathname, backupPath);

    // Step 3: Move temp to main (atomic on POSIX)
    fs.renameSync(tempPath, pathname);
    fs.chmodSync(pathname, 0o600);

    // Step 4: Remove backup only after successful migration
    // If we crash before this, tryRecoverFromBackup won't do anything
    // because the main file exists. The .bak file just stays as extra safety.
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Ignore - leaving .bak file is safe, just uses extra disk space
    }

    return true;
  } catch {
    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup errors
    }
    // Try to restore from backup if main file is missing
    tryRecoverFromBackup(pathname);
    return false;
  }
}
