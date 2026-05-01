import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveStateDir } from "../paths.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

const MASTER_KEY_PATH = ".master-key";

function getMasterKeyPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, MASTER_KEY_PATH);
}

function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256",
  );
}

function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

function generateIV(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Generate or load a secure passphrase for session encryption.
 * Uses a random key stored in a secure location with fallback to system metadata.
 */
function getSecurePassphrase(): string {
  const stateDir = resolveStateDir();
  const passphrasePath = path.join(stateDir, ".session-encryption-key");
  
  // Try to load existing passphrase
  if (fs.existsSync(passphrasePath)) {
    try {
      const data = fs.readFileSync(passphrasePath, "utf8");
      const parsed = JSON.parse(data);
      if (parsed.version === 1 && typeof parsed.key === "string") {
        return parsed.key;
      }
    } catch {
      // If we can't read the stored key, fall back to legacy method
    }
  }
  
  // Generate new secure random passphrase
  const passphrase = crypto.randomBytes(32).toString("hex");
  
  // Store it securely with restrictive permissions
  const dataToStore = JSON.stringify({
    version: 1,
    key: passphrase,
    createdAt: new Date().toISOString(),
    note: "Session transcript encryption key - keep secure",
  });
  
  try {
    fs.writeFileSync(passphrasePath, dataToStore, { mode: 0o600 });
  } catch (error) {
    console.error("Failed to store secure passphrase:", error);
    // Fallback to legacy method if we can't store securely
    return generateLegacyPassphrase();
  }
  
  return passphrase;
}

/**
 * Legacy fallback: generate passphrase from system metadata.
 * Used only when secure storage fails.
 */
function generateLegacyPassphrase(): string {
  console.warn("Using legacy system metadata for session encryption key derivation");
  
  const identifiers = [
    os.hostname(),
    os.userInfo().username,
    os.homedir(),
    os.type(),
    os.arch(),
    process.env.USER || '',
    process.env.HOME || '',
  ];
  
  const combined = identifiers.join('|');
  const hash = crypto.createHash('sha256').update(combined).digest('hex');
  return hash;
}

/**
 * Initialize or load the master encryption key.
 */
export function initializeMasterKey(): Buffer {
  const keyPath = getMasterKeyPath();
  
  if (fs.existsSync(keyPath)) {
    // Load existing key
    const data = fs.readFileSync(keyPath);
    const parts = data.toString("utf8").split(":");
    if (parts.length !== 4) {
      throw new Error("Invalid master key format");
    }
    
    const [saltBase64, ivBase64, authTagBase64, encryptedKeyBase64] = parts;
    const salt = Buffer.from(saltBase64, "base64");
    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");
    const encryptedKey = Buffer.from(encryptedKeyBase64, "base64");
    
    // Use secure passphrase
    const passphrase = getSecurePassphrase();
    const derivedKey = deriveKeyFromPassphrase(passphrase, salt);
    
    // Decrypt the master key
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);
    
    const masterKey = Buffer.concat([
      decipher.update(encryptedKey),
      decipher.final(),
    ]);
    
    return masterKey;
  }
  
  // Generate new key
  const masterKey = crypto.randomBytes(KEY_LENGTH);
  const salt = generateSalt();
  // Use secure passphrase
  const passphrase = getSecurePassphrase();
  const derivedKey = deriveKeyFromPassphrase(passphrase, salt);
  
  // Encrypt the master key with the derived key
  const iv = generateIV();
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(masterKey),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  // Store: salt:iv:authTag:encryptedKey
  const dataToStore = `${salt.toString("base64")}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
  fs.writeFileSync(keyPath, dataToStore, "utf8");
  
  return masterKey;
}

/**
 * Get the master encryption key, initializing if necessary.
 */
let masterKeyCache: Buffer | null = null;
export function getMasterKey(): Buffer {
  if (masterKeyCache) {
    return masterKeyCache;
  }
  
  masterKeyCache = initializeMasterKey();
  return masterKeyCache;
}

/**
 * Encrypt data.
 */
export function encryptData(plaintext: string): string {
  const key = getMasterKey();
  const iv = generateIV();
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt data.
 */
export function decryptData(encryptedData: string): string {
  const key = getMasterKey();
  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format");
  }
  
  const [ivBase64, authTagBase64, encryptedBase64] = parts;
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  
  return decrypted.toString("utf8");
}
