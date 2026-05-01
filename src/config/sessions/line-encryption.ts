import crypto from "node:crypto";
import { getMasterKey } from "./encryption.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Magic prefix for encrypted lines
 */
const ENCRYPTED_LINE_PREFIX = "ENCRYPTED:";

/**
 * Check if a line is encrypted.
 */
export function isLineEncrypted(line: string): boolean {
  return line.startsWith(ENCRYPTED_LINE_PREFIX);
}

/**
 * Encrypt a single JSON line.
 */
export function encryptLine(plaintextLine: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintextLine, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  return `${ENCRYPTED_LINE_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a single encrypted line.
 */
export function decryptLine(encryptedLine: string): string {
  if (!isLineEncrypted(encryptedLine)) {
    return encryptedLine; // Already plaintext
  }
  
  // Remove prefix
  const data = encryptedLine.slice(ENCRYPTED_LINE_PREFIX.length);
  const parts = data.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted line format");
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
 * Process a file line by line, encrypting or decrypting as needed.
 */
export async function processFileLines(
  filePath: string,
  processFn: (line: string) => Promise<string>,
): Promise<string[]> {
  // This would be implemented to read a file and process each line
  // For now, it's a placeholder for the pattern
  throw new Error("Not implemented");
}

/**
 * Read a file and decrypt lines if encrypted.
 */
export function readEncryptedLines(filePath: string): string[] {
  const fs = require("node:fs");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const processedLines: string[] = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      processedLines.push(line);
      continue;
    }
    
    try {
      if (isLineEncrypted(line)) {
        const decrypted = decryptLine(line);
        processedLines.push(decrypted);
      } else {
        processedLines.push(line);
      }
    } catch (error) {
      // If decryption fails, keep the line as-is (might be malformed or new format)
      console.error("Failed to decrypt line:", error);
      processedLines.push(line);
    }
  }
  
  return processedLines;
}

/**
 * Read a file and return decrypted content as a single string.
 */
export function readEncryptedFile(filePath: string): string {
  const lines = readEncryptedLines(filePath);
  return lines.join("\n");
}

/**
 * Check if a file contains encrypted lines.
 */
export function isFileUsingEncryptedLines(filePath: string): boolean {
  const fs = require("node:fs");
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  
  for (const line of lines) {
    if (line.trim()) {
      return isLineEncrypted(line);
    }
  }
  
  return false;
}

/**
 * Write lines to a file, encrypting them.
 */
export async function writeEncryptedLines(
  filePath: string,
  lines: string[],
  encrypt: boolean = true,
): Promise<void> {
  const fs = await import("node:fs");
  const processedLines: string[] = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      processedLines.push(line);
      continue;
    }
    
    if (encrypt) {
      try {
        const encrypted = await encryptLine(line);
        processedLines.push(encrypted);
      } catch (error) {
        console.error("Failed to encrypt line:", error);
        processedLines.push(line); // Fall back to plaintext
      }
    } else {
      processedLines.push(line);
    }
  }
  
  fs.writeFileSync(filePath, processedLines.join("\n"), "utf8");
}
