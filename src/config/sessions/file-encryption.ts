import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMasterKey } from "./encryption.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Magic header to identify encrypted files
 */
const ENCRYPTION_MAGIC = "OPENCLAW_ENCRYPTED_V1\n";

/**
 * Check if a file is encrypted.
 */
export function isFileEncrypted(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(ENCRYPTION_MAGIC.length);
    fs.readSync(fd, buffer, 0, ENCRYPTION_MAGIC.length, 0);
    fs.closeSync(fd);
    
    return buffer.toString("utf8") === ENCRYPTION_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Read a file, decrypting if encrypted.
 */
export function readEncryptedFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  
  if (!content.startsWith(ENCRYPTION_MAGIC)) {
    return content; // Plaintext
  }
  
  // Remove magic header
  const encryptedContent = content.slice(ENCRYPTION_MAGIC.length);
  
  // Parse: iv:authTag:encrypted
  const parts = encryptedContent.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format");
  }
  
  const [ivBase64, authTagBase64, encryptedBase64] = parts;
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");
  
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  
  return decrypted.toString("utf8");
}

/**
 * Write a file, encrypting if requested.
 */
export function writeEncryptedFile(
  filePath: string,
  content: string,
  encrypt: boolean = true,
): void {
  if (!encrypt) {
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }
  
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(content, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  const encryptedContent = `${ENCRYPTION_MAGIC}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
  fs.writeFileSync(filePath, encryptedContent, "utf8");
}

/**
 * Migrate a plaintext file to encrypted format.
 */
export function migrateToEncrypted(filePath: string): void {
  if (isFileEncrypted(filePath)) {
    return; // Already encrypted
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  
  // Create backup
  const backupPath = `${filePath}.backup-${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  
  // Write encrypted version
  writeEncryptedFile(filePath, content, true);
}

/**
 * Encrypt a session file if it's plaintext.
 */
export function encryptSessionFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  
  if (isFileEncrypted(filePath)) {
    return; // Already encrypted
  }
  
  migrateToEncrypted(filePath);
}

/**
 * Read a file line by line, handling encryption transparently.
 */
export function readEncryptedFileLines(filePath: string): string[] {
  const content = readEncryptedFile(filePath);
  return content.split(/\r?\n/);
}
