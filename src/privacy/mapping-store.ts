/**
 * Encrypted mapping store — persists privacy mappings using AES-256-GCM.
 * Each record has an independent IV to prevent pattern analysis.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PrivacyMapping } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha512";
const LOCK_WAIT_TIMEOUT_MS = 2_000;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_RETRY_MS = 25;
const FILE_MODE_OWNER_RW = 0o600;
const DIR_MODE_OWNER_RWX = 0o700;

/** Default storage directory. */
function defaultStorePath(): string {
  return join(homedir(), ".openclaw", "privacy", "mappings.enc");
}

/** Default machine key path used to strengthen local-at-rest encryption. */
function defaultMachineKeyPath(): string {
  return join(homedir(), ".openclaw", "privacy", "master.key");
}

/** Derive an AES-256 key from a passphrase + salt using PBKDF2. */
function deriveKey(passphrase: string, salt: string): Buffer {
  const saltBuffer = Buffer.from(salt || `openclaw-default-salt-${homedir()}`, "utf8");
  return pbkdf2Sync(passphrase, saltBuffer, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/** Legacy key derivation used by older builds (kept for backward-compatible reads). */
function deriveLegacyKey(salt: string): Buffer {
  const passphrase = `openclaw-privacy-${process.env.USER ?? "default"}`;
  return deriveKey(passphrase, salt);
}

function ensureOwnerOnlyPermissions(path: string): void {
  try {
    chmodSync(path, FILE_MODE_OWNER_RW);
  } catch {
    // Best-effort only on platforms/filesystems that don't support chmod semantics.
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: DIR_MODE_OWNER_RWX });
  }
}

function loadOrCreateMachinePassphrase(customPath?: string): string {
  const path = customPath || defaultMachineKeyPath();
  const dir = dirname(path);
  ensureDir(dir);

  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length > 0) {
      ensureOwnerOnlyPermissions(path);
      return raw.toString("base64");
    }
  }

  const secret = randomBytes(32);
  writeFileSync(path, secret, { mode: FILE_MODE_OWNER_RW });
  ensureOwnerOnlyPermissions(path);
  return secret.toString("base64");
}

function sleepMs(ms: number): void {
  // Atomics.wait() throws on the Node.js main thread, so use a busy-wait
  // with hrtime for sub-millisecond accuracy. This only runs during lock
  // contention retries, which are rare and short-lived.
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < end) {
    // spin
  }
}

/** Encrypt a plaintext string. Returns a Buffer: [IV (16)] [authTag (16)] [ciphertext]. */
function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/** Decrypt a buffer produced by encrypt(). */
function decrypt(data: Buffer, key: Buffer): string {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}

export class PrivacyMappingStore {
  private storePath: string;
  private key: Buffer;
  private legacyKey: Buffer;
  private lockPath: string;

  constructor(options?: { storePath?: string; salt?: string }) {
    this.storePath = options?.storePath || defaultStorePath();
    const salt = options?.salt ?? "";
    const machineKeyPath = join(dirname(this.storePath), "master.key");
    const passphrase = loadOrCreateMachinePassphrase(machineKeyPath);
    this.key = deriveKey(passphrase, salt);
    this.legacyKey = deriveLegacyKey(salt);
    this.lockPath = `${this.storePath}.lock`;
  }

  /** Save mappings to encrypted file. */
  save(mappings: PrivacyMapping[]): void {
    this.withWriteLock(() => {
      this.saveUnlocked(mappings);
    });
  }

  /** Load mappings from encrypted file. Returns empty array if file doesn't exist. */
  load(): PrivacyMapping[] {
    if (!existsSync(this.storePath)) {
      return [];
    }
    const data = readFileSync(this.storePath);
    const decoded = this.tryDecrypt(data, this.key) ?? this.tryDecrypt(data, this.legacyKey);
    return decoded ?? [];
  }

  /** Load only mappings for a specific session. */
  loadSession(sessionId: string): PrivacyMapping[] {
    // Use write-lock so we cannot observe a partially-written file from another concurrent instance.
    return this.withWriteLock(() => this.load().filter((m) => m.sessionId === sessionId));
  }

  /** Append new mappings (merges with existing). */
  append(newMappings: PrivacyMapping[]): void {
    if (newMappings.length === 0) {
      return;
    }
    this.withWriteLock(() => {
      const existing = this.load();
      const existingIds = new Set(existing.map((m) => m.id));
      const toAdd = newMappings.filter((m) => !existingIds.has(m.id));
      if (toAdd.length > 0) {
        this.saveUnlocked([...existing, ...toAdd]);
      }
    });
  }

  /** Remove expired mappings (older than ttlMs). */
  cleanup(ttlMs: number): number {
    return this.withWriteLock(() => {
      const mappings = this.load();
      const cutoff = Date.now() - ttlMs;
      const kept = mappings.filter((m) => m.createdAt > cutoff);
      const removed = mappings.length - kept.length;
      if (removed > 0) {
        this.saveUnlocked(kept);
      }
      return removed;
    });
  }

  /** Remove all mappings for a specific session. */
  clearSession(sessionId: string): void {
    this.withWriteLock(() => {
      const mappings = this.load();
      const kept = mappings.filter((m) => m.sessionId !== sessionId);
      if (kept.length < mappings.length) {
        this.saveUnlocked(kept);
      }
    });
  }

  /** Delete the store file entirely. */
  destroy(): void {
    this.withWriteLock(() => {
      if (existsSync(this.storePath)) {
        unlinkSync(this.storePath);
      }
    });
  }

  private saveUnlocked(mappings: PrivacyMapping[]): void {
    const dir = dirname(this.storePath);
    ensureDir(dir);
    const json = JSON.stringify(mappings);
    const encrypted = encrypt(json, this.key);
    // Write to a temp file then rename for atomic replacement — prevents a partial
    // file if the process is killed mid-write.
    const tmpPath = `${this.storePath}.tmp`;
    writeFileSync(tmpPath, encrypted, { mode: FILE_MODE_OWNER_RW });
    ensureOwnerOnlyPermissions(tmpPath);
    renameSync(tmpPath, this.storePath);
    ensureOwnerOnlyPermissions(this.storePath);
  }

  private tryDecrypt(data: Buffer, key: Buffer): PrivacyMapping[] | null {
    try {
      const json = decrypt(data, key);
      return JSON.parse(json) as PrivacyMapping[];
    } catch {
      return null;
    }
  }

  private withWriteLock<T>(fn: () => T): T {
    const startedAt = Date.now();
    let lockFd: number | null = null;

    // Ensure the parent directory exists before attempting to open the lock file.
    // Without this, a custom storePath in a new directory would throw ENOENT and
    // the error would be swallowed by filterText, silently losing all mappings.
    ensureDir(dirname(this.lockPath));

    while (lockFd === null) {
      try {
        lockFd = openSync(this.lockPath, "wx", FILE_MODE_OWNER_RW);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }

        if (this.isLockStale()) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Another process may have already removed/replaced it.
          }
          continue;
        }

        if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
          throw new Error(`privacy mapping store lock timeout: ${this.lockPath}`, { cause: err });
        }
        sleepMs(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      if (lockFd !== null) {
        try {
          closeSync(lockFd);
        } finally {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Best-effort unlock.
          }
        }
      }
    }
  }

  private isLockStale(): boolean {
    try {
      if (!existsSync(this.lockPath)) {
        return false;
      }
      const stat = statSync(this.lockPath);
      return Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS;
    } catch {
      return false;
    }
  }
}
