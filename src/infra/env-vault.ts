import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveConfigDir } from "../utils.js";

const log = createSubsystemLogger("env-vault");

// ---------------------------------------------------------------------------
// Crypto helpers — AES-256-GCM with scrypt key derivation
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

export function encrypt(plaintext: string, password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: base64(salt + iv + authTag + ciphertext)
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString("base64");
}

export function decrypt(encoded: string, password: string): string {
  const combined = Buffer.from(encoded, "base64");

  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ---------------------------------------------------------------------------
// Vault database — encrypted SQLite key-value store
// ---------------------------------------------------------------------------

export type VaultEntry = {
  key: string;
  value: string;
};

export type VaultOptions = {
  /** Path to the vault SQLite database. */
  vaultPath?: string;
  /** Master password for encryption/decryption. */
  masterPassword: string;
  /** Environment object (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
};

function resolveVaultPath(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) {
    return override;
  }
  const dir = resolveConfigDir(env);
  return path.join(dir, "vault.db");
}

function ensureVaultSchema(db: InstanceType<typeof import("node:sqlite").DatabaseSync>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_secrets (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Opens (or creates) the vault database and returns a handle object.
 * The caller is responsible for calling `close()` when done.
 */
export function openVault(opts: VaultOptions) {
  const env = opts.env ?? process.env;
  const vaultPath = resolveVaultPath(env, opts.vaultPath);
  const password = opts.masterPassword;

  const dir = path.dirname(vaultPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(vaultPath);
  ensureVaultSchema(db);

  // Restrict file permissions (owner-only read/write).
  try {
    fs.chmodSync(vaultPath, 0o600);
  } catch {
    // best-effort (Windows may not support chmod)
  }

  return {
    /** List all stored keys (values are not decrypted). */
    listKeys(): string[] {
      const stmt = db.prepare("SELECT key FROM env_secrets ORDER BY key");
      const rows = stmt.all() as Array<{ key: string }>;
      return rows.map((r) => r.key);
    },

    /** Get a single decrypted value. Returns `null` if not found. */
    get(key: string): string | null {
      const stmt = db.prepare("SELECT value FROM env_secrets WHERE key = ?");
      const row = stmt.get(key) as { value: string } | undefined;
      if (!row) {
        return null;
      }
      try {
        return decrypt(row.value, password);
      } catch {
        log.warn(`Failed to decrypt vault entry: ${key}`);
        return null;
      }
    },

    /** Get all entries, decrypted. Skips entries that fail to decrypt. */
    getAll(): VaultEntry[] {
      const stmt = db.prepare("SELECT key, value FROM env_secrets ORDER BY key");
      const rows = stmt.all() as Array<{ key: string; value: string }>;
      const entries: VaultEntry[] = [];
      for (const row of rows) {
        try {
          entries.push({ key: row.key, value: decrypt(row.value, password) });
        } catch {
          log.warn(`Skipping vault entry that failed to decrypt: ${row.key}`);
        }
      }
      return entries;
    },

    /** Set (upsert) an encrypted value. */
    set(key: string, value: string): void {
      const encrypted = encrypt(value, password);
      const stmt = db.prepare(`
        INSERT INTO env_secrets (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `);
      stmt.run(key, encrypted);
    },

    /** Remove a key from the vault. Returns true if it existed. */
    remove(key: string): boolean {
      const stmt = db.prepare("DELETE FROM env_secrets WHERE key = ?");
      const result = stmt.run(key);
      return result.changes > 0;
    },

    /** Close the database handle. */
    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Startup integration — load vault secrets into process.env
// ---------------------------------------------------------------------------

/**
 * Resolves vault configuration from the environment.
 * Returns `null` if the master password is not set.
 *
 * Bootstrap env var: `OPENCLAW_VAULT_PASSWORD`
 * Optional: `OPENCLAW_VAULT_PATH` to override the default vault location.
 */
export function resolveVaultConfig(env: NodeJS.ProcessEnv): VaultOptions | null {
  const masterPassword = env.OPENCLAW_VAULT_PASSWORD?.trim();
  if (!masterPassword) {
    return null;
  }

  return {
    masterPassword,
    vaultPath: env.OPENCLAW_VAULT_PATH?.trim() || undefined,
    env,
  };
}

/**
 * Loads secrets from the encrypted vault into the given env object.
 * Existing non-empty values are NOT overridden (same semantics as dotenv).
 *
 * This is a no-op when `OPENCLAW_VAULT_PASSWORD` is not set or the vault
 * file does not exist.
 *
 * @returns The number of env vars applied, or 0 on skip/failure.
 */
export function loadVaultEnv(opts?: { env?: NodeJS.ProcessEnv }): number {
  const env = opts?.env ?? process.env;
  const config = resolveVaultConfig(env);

  if (!config) {
    return 0;
  }

  const vaultPath = resolveVaultPath(env, config.vaultPath);
  if (!fs.existsSync(vaultPath)) {
    return 0;
  }

  try {
    const vault = openVault(config);
    try {
      const entries = vault.getAll();
      let applied = 0;

      for (const { key, value } of entries) {
        if (!key.trim()) {
          continue;
        }
        // Don't override existing non-empty env vars.
        if (env[key]?.trim()) {
          continue;
        }
        env[key] = value;
        applied += 1;
      }

      if (applied > 0) {
        log.info(`Loaded ${applied} env var(s) from encrypted vault`);
      }

      return applied;
    } finally {
      vault.close();
    }
  } catch (err) {
    log.warn(`Failed to load vault: ${String(err)}`);
    return 0;
  }
}
