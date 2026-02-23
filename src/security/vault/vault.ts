import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keychainAvailable, getOrCreateKeychainDek } from "./keychain.js";
import { deriveKey, generateSalt, resolvePassphrase } from "./passphrase.js";
import type { EncryptedEnvelope, Vault, VaultOptions } from "./types.js";
import { VAULT_ENVELOPE_MARKER } from "./types.js";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function isEnvelope(content: string): boolean {
  return content.trimStart().startsWith(VAULT_ENVELOPE_MARKER);
}

function parseEnvelope(json: string): EncryptedEnvelope {
  const parsed = JSON.parse(json) as Partial<EncryptedEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "aes-256-gcm" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string" ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.kdf !== "string"
  ) {
    throw new Error("Invalid encrypted envelope: missing required fields");
  }
  return parsed as EncryptedEnvelope;
}

function encryptWithKey(plaintext: string, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "keychain",
    salt: "",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptWithKey(envelope: EncryptedEnvelope, key: Buffer): string {
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

function resolveVaultKeyFilePath(stateDir: string): string {
  return path.join(stateDir, "vault-key.json");
}

type StoredKeyFile = {
  salt: string;
  check: string;
};

async function ensurePassphraseDek(
  stateDir: string,
  passphrase: string,
): Promise<{ key: Buffer; salt: Buffer }> {
  const keyFilePath = resolveVaultKeyFilePath(stateDir);

  try {
    const raw = fs.readFileSync(keyFilePath, "utf8");
    const stored = JSON.parse(raw) as StoredKeyFile;
    const salt = Buffer.from(stored.salt, "base64");
    const key = await deriveKey(passphrase, salt);
    // Verify against the stored check value
    const checkEnvelope = parseEnvelope(stored.check);
    const checkResult = decryptWithKey(checkEnvelope, key);
    if (checkResult !== "openclaw-vault-check") {
      throw new Error("Vault passphrase is incorrect");
    }
    return { key, salt };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT" && (err as Error).message === "Vault passphrase is incorrect") {
      throw err;
    }
  }

  // First-time setup: generate salt, derive key, store check value
  const salt = generateSalt();
  const key = await deriveKey(passphrase, salt);
  const checkEnvelope = encryptWithKey("openclaw-vault-check", key);
  // Tag the check envelope with passphrase kdf info
  checkEnvelope.kdf = "pbkdf2-sha512";
  checkEnvelope.salt = salt.toString("base64");

  const keyFile: StoredKeyFile = {
    salt: salt.toString("base64"),
    check: JSON.stringify(checkEnvelope),
  };

  const dir = path.dirname(keyFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFilePath, `${JSON.stringify(keyFile, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(keyFilePath, 0o600);
  } catch {
    // best-effort
  }

  return { key, salt };
}

export function createVault(options: VaultOptions): Vault {
  let cachedKey: Buffer | null = null;
  let cachedKdf: EncryptedEnvelope["kdf"] = "keychain";
  let initialized = false;

  async function resolveBackend(): Promise<"keychain" | "passphrase"> {
    if (options.backend === "keychain") {
      return "keychain";
    }
    if (options.backend === "passphrase") {
      return "passphrase";
    }
    // auto: prefer keychain
    const available = await keychainAvailable();
    return available ? "keychain" : "passphrase";
  }

  async function ensureKeyInternal(): Promise<void> {
    if (initialized && cachedKey) {
      return;
    }
    const backend = await resolveBackend();
    if (backend === "keychain") {
      cachedKey = await getOrCreateKeychainDek(options.stateDir);
      cachedKdf = "keychain";
    } else {
      const passphrase = resolvePassphrase(options.passphrase);
      if (!passphrase) {
        throw new Error(
          "Vault passphrase required: set OPENCLAW_VAULT_PASSPHRASE or pass --passphrase",
        );
      }
      const result = await ensurePassphraseDek(options.stateDir, passphrase);
      cachedKey = result.key;
      cachedKdf = "pbkdf2-sha512";
    }
    initialized = true;
  }

  async function encrypt(plaintext: string): Promise<string> {
    await ensureKeyInternal();
    const envelope = encryptWithKey(plaintext, cachedKey!);
    if (cachedKdf === "pbkdf2-sha512") {
      const salt = generateSalt();
      const passphrase = resolvePassphrase(options.passphrase);
      const perFileKey = await deriveKey(passphrase!, salt);
      const perFileEnvelope = encryptWithKey(plaintext, perFileKey);
      perFileEnvelope.kdf = "pbkdf2-sha512";
      perFileEnvelope.salt = salt.toString("base64");
      return JSON.stringify(perFileEnvelope);
    }
    envelope.kdf = cachedKdf;
    return JSON.stringify(envelope);
  }

  async function decrypt(envelopeJson: string): Promise<string> {
    const envelope = parseEnvelope(envelopeJson);

    if (envelope.kdf === "pbkdf2-sha512") {
      const passphrase = resolvePassphrase(options.passphrase);
      if (!passphrase) {
        throw new Error(
          "Vault passphrase required to decrypt: set OPENCLAW_VAULT_PASSPHRASE or pass --passphrase",
        );
      }
      const salt = Buffer.from(envelope.salt, "base64");
      const key = await deriveKey(passphrase, salt);
      return decryptWithKey(envelope, key);
    }

    // keychain-backed envelope
    await ensureKeyInternal();
    return decryptWithKey(envelope, cachedKey!);
  }

  async function rotateKey(newPassphrase?: string): Promise<void> {
    // Rotation: the caller is responsible for re-encrypting files.
    // This resets the cached key so the next ensureKey() creates a fresh one.
    cachedKey = null;
    initialized = false;
    if (newPassphrase) {
      options.passphrase = newPassphrase;
    }
    // Remove existing passphrase key file so a new one is generated
    const keyFilePath = resolveVaultKeyFilePath(options.stateDir);
    try {
      fs.unlinkSync(keyFilePath);
    } catch {
      // ignore
    }
    await ensureKeyInternal();
  }

  return {
    encrypt,
    decrypt,
    isEncrypted: isEnvelope,
    ensureKey: ensureKeyInternal,
    rotateKey,
  };
}

/** Check whether a string looks like an encrypted vault envelope. */
export function isVaultEncrypted(content: string): boolean {
  return isEnvelope(content);
}

/**
 * Transparently read a file that may or may not be encrypted.
 * Returns the decrypted content, or the raw content if not encrypted.
 */
export async function vaultDecryptFileContent(
  content: string,
  vault: Vault | null,
): Promise<string> {
  if (!vault) {
    return content;
  }
  if (!vault.isEncrypted(content)) {
    return content;
  }
  return vault.decrypt(content);
}

/**
 * Encrypt content for writing to a file. If vault is null, returns content as-is.
 */
export async function vaultEncryptForWrite(content: string, vault: Vault | null): Promise<string> {
  if (!vault) {
    return content;
  }
  return vault.encrypt(content);
}
