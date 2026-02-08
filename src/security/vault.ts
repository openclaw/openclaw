import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

const VAULT_VERSION = 1;
const SCRYPT_SALT_LEN = 16;
const SCRYPT_KEY_LEN = 32; // AES-256
const AES_IV_LEN = 12; // GCM standard
const RECOMENDED_SCRYPT_COST = {
  N: 16384, // CPU/memory cost
  r: 8, // Block size
  p: 1, // Parallelization
};

// Vault schema for validating the file on disk
const VaultSchema = z.object({
  version: z.number(),
  kdf: z.object({
    algorithm: z.literal("scrypt"),
    salt: z.string(), // base64
    N: z.number(),
    r: z.number(),
    p: z.number(),
  }),
  iv: z.string(), // base64
  authTag: z.string(), // base64
  data: z.string(), // base64
});

export type VaultFile = z.infer<typeof VaultSchema>;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Derives a 32-byte key from the password using Scrypt.
 */
async function deriveKey(
  password: string,
  salt: Buffer,
  cost = RECOMENDED_SCRYPT_COST,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LEN,
      { N: cost.N, r: cost.r, p: cost.p },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey as Buffer);
        }
      },
    );
  });
}

/**
 * Encrypts a record of secrets into a vault buffer (JSON string check).
 */
export async function encryptVault(
  secrets: Record<string, string>,
  password: string,
): Promise<Buffer> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const key = await deriveKey(password, salt);
  const iv = crypto.randomBytes(AES_IV_LEN);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(secrets);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag().toString("base64");

  const vault: VaultFile = {
    version: VAULT_VERSION,
    kdf: {
      algorithm: "scrypt",
      salt: salt.toString("base64"),
      ...RECOMENDED_SCRYPT_COST,
    },
    iv: iv.toString("base64"),
    authTag,
    data: encrypted,
  };

  return Buffer.from(JSON.stringify(vault, null, 2), "utf8");
}

/**
 * Decrypts a vault buffer into a record of secrets.
 * Throws VaultError if password is incorrect or file is corrupted.
 */
export async function decryptVault(
  vaultBuffer: Buffer,
  password: string,
): Promise<Record<string, string>> {
  let vault: VaultFile;
  try {
    const raw = JSON.parse(vaultBuffer.toString("utf8"));
    vault = VaultSchema.parse(raw);
  } catch (_err) {
    throw new VaultError("Invalid vault file format");
  }

  const salt = Buffer.from(vault.kdf.salt, "base64");
  const iv = Buffer.from(vault.iv, "base64");
  const authTag = Buffer.from(vault.authTag, "base64");
  const encryptedText = vault.data;

  // Derive key using the same parameters stored in the vault
  const key = await deriveKey(password, salt, {
    N: vault.kdf.N,
    r: vault.kdf.r,
    p: vault.kdf.p,
  });

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch (_err) {
    // AEAD authentication failed (wrong password or tampering)
    throw new VaultError("Access Denied: Incorrect password or corrupted vault");
  }
}

/**
 * Helper to check if a file path is a valid vault (structural check only).
 */
export function isVaultFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(content);
    return VaultSchema.safeParse(json).success;
  } catch {
    return false;
  }
}
