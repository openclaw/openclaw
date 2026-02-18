/**
 * Encrypted Secret Storage
 *
 * Provides a unified interface for storing secrets with multiple backends:
 * - plaintext: Current behavior (env vars / config file)
 * - keychain: macOS Keychain via `security` CLI (no shell injection risk)
 * - encrypted-file: AES-256-GCM encrypted file (cross-platform)
 *
 * Addresses: T-ACCESS-003 (P1), R-005 (P1)
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SecretStoreBackend = "plaintext" | "keychain" | "encrypted-file";

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  list(): string[];
  readonly backend: SecretStoreBackend;
}

const KEYCHAIN_SERVICE = "com.openclaw.secrets";
const ENCRYPTED_FILE_DIR = path.join(os.homedir(), ".openclaw", "secrets");
const ENCRYPTED_FILE_PATH = path.join(ENCRYPTED_FILE_DIR, "vault.enc");
const SALT_PATH = path.join(ENCRYPTED_FILE_DIR, "vault.salt");

// ---------------------------------------------------------------------------
// Plaintext backend (current behavior — reads from process.env)
// ---------------------------------------------------------------------------

class PlaintextStore implements SecretStore {
  readonly backend = "plaintext" as const;
  private store = new Map<string, string>();

  get(key: string): string | null {
    return this.store.get(key) ?? process.env[key] ?? null;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
    process.env[key] = value;
  }

  delete(key: string): boolean {
    const had = this.store.has(key);
    this.store.delete(key);
    delete process.env[key];
    return had;
  }

  list(): string[] {
    return Array.from(this.store.keys());
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
// ---------------------------------------------------------------------------

class KeychainStore implements SecretStore {
  readonly backend = "keychain" as const;

  get(key: string): string | null {
    try {
      const result = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key, "-w"],
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      return result.trim();
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    // Delete existing entry first (add fails if it exists)
    try {
      execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key], {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Ignore if it doesn't exist
    }

    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        key,
        "-w",
        value,
        "-U", // Update if exists
      ],
      {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  delete(key: string): boolean {
    try {
      execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key], {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  list(): string[] {
    try {
      const result = execFileSync("security", ["dump-keychain"], {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const keys: string[] = [];
      const serviceRegex = new RegExp(
        `"svce"<blob>="${KEYCHAIN_SERVICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
      const accountRegex = /"acct"<blob>="([^"]+)"/;
      const lines = result.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (serviceRegex.test(lines[i] ?? "")) {
          // Look for the account in nearby lines
          for (let j = Math.max(0, i - 5); j < Math.min(lines.length, i + 5); j++) {
            const match = accountRegex.exec(lines[j] ?? "");
            if (match?.[1]) {
              keys.push(match[1]);
              break;
            }
          }
        }
      }
      return keys;
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Encrypted file backend (AES-256-GCM)
//
// Security note: The encryption key is derived from machine attributes
// (hostname, username, home directory) + a random salt. This protects secrets
// against off-machine theft (e.g., stolen backups, cloud sync exposure) but
// does NOT protect against other local users who know these attributes.
// For stronger protection on macOS, use the "keychain" backend instead.
// ---------------------------------------------------------------------------

class EncryptedFileStore implements SecretStore {
  readonly backend = "encrypted-file" as const;
  private derivedKey: Buffer | null = null;

  private getDerivedKey(): Buffer {
    if (this.derivedKey) {
      return this.derivedKey;
    }

    if (!fs.existsSync(ENCRYPTED_FILE_DIR)) {
      fs.mkdirSync(ENCRYPTED_FILE_DIR, { recursive: true, mode: 0o700 });
    }

    let salt: Buffer;
    if (fs.existsSync(SALT_PATH)) {
      salt = fs.readFileSync(SALT_PATH);
    } else {
      salt = crypto.randomBytes(32);
      fs.writeFileSync(SALT_PATH, salt, { mode: 0o600 });
    }

    // Derive key from machine fingerprint + salt
    const fingerprint = `${os.hostname()}:${os.userInfo().username}:${os.homedir()}`;
    this.derivedKey = crypto.pbkdf2Sync(fingerprint, salt, 100_000, 32, "sha512");
    return this.derivedKey;
  }

  private readVault(): Record<string, string> {
    if (!fs.existsSync(ENCRYPTED_FILE_PATH)) {
      return {};
    }
    try {
      const data = fs.readFileSync(ENCRYPTED_FILE_PATH);
      if (data.length < 28) {
        return {}; // Too short to contain IV + tag + data
      }
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const encrypted = data.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.getDerivedKey(), iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return JSON.parse(decrypted.toString("utf-8"));
    } catch {
      return {};
    }
  }

  private writeVault(data: Record<string, string>): void {
    if (!fs.existsSync(ENCRYPTED_FILE_DIR)) {
      fs.mkdirSync(ENCRYPTED_FILE_DIR, { recursive: true, mode: 0o700 });
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getDerivedKey(), iv);
    const jsonData = Buffer.from(JSON.stringify(data), "utf-8");
    const encrypted = Buffer.concat([cipher.update(jsonData), cipher.final()]);
    const tag = cipher.getAuthTag();
    const output = Buffer.concat([iv, tag, encrypted]);
    fs.writeFileSync(ENCRYPTED_FILE_PATH, output, { mode: 0o600 });
  }

  get(key: string): string | null {
    const vault = this.readVault();
    return vault[key] ?? null;
  }

  set(key: string, value: string): void {
    const vault = this.readVault();
    vault[key] = value;
    this.writeVault(vault);
  }

  delete(key: string): boolean {
    const vault = this.readVault();
    if (!(key in vault)) {
      return false;
    }
    delete vault[key];
    this.writeVault(vault);
    return true;
  }

  list(): string[] {
    return Object.keys(this.readVault());
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a secret store instance for the given backend.
 */
export function createSecretStore(backend: SecretStoreBackend = "plaintext"): SecretStore {
  switch (backend) {
    case "keychain": {
      if (process.platform !== "darwin") {
        throw new Error("Keychain backend is only available on macOS");
      }
      return new KeychainStore();
    }
    case "encrypted-file":
      return new EncryptedFileStore();
    case "plaintext":
    default:
      return new PlaintextStore();
  }
}

// Singleton
let globalStore: SecretStore | null = null;

export function getGlobalSecretStore(): SecretStore {
  if (!globalStore) {
    globalStore = createSecretStore("plaintext");
  }
  return globalStore;
}

export function initGlobalSecretStore(backend: SecretStoreBackend): SecretStore {
  globalStore = createSecretStore(backend);
  return globalStore;
}
