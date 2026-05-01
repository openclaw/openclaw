import fs from "node:fs";
import path from "node:path";
import { encryptLine } from "./line-encryption.js";
import { isTranscriptEncrypted } from "./transcript-reader.js";

/**
 * Migrate a plaintext transcript file to encrypted format.
 */
export function migrateTranscriptToEncrypted(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  // Check if already encrypted
  if (isTranscriptEncrypted(filePath)) {
    return true; // Already encrypted
  }
  
  try {
    // Read all lines
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const encryptedLines: string[] = [];
    
    for (const line of lines) {
      if (!line.trim()) {
        encryptedLines.push(line);
        continue;
      }
      
      try {
        // Encrypt each non-empty line
        const encryptedLine = encryptLine(line);
        encryptedLines.push(encryptedLine);
      } catch (error) {
        console.error("Failed to encrypt line:", error);
        encryptedLines.push(line); // Keep plaintext if encryption fails
      }
    }
    
    // Create backup
    const backupPath = `${filePath}.backup-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    
    // Write back encrypted file
    fs.writeFileSync(filePath, encryptedLines.join("\n"), "utf8");
    
    console.log(`Migrated ${filePath} to encrypted format (backup: ${backupPath})`);
    return true;
  } catch (error) {
    console.error(`Failed to migrate ${filePath}:`, error);
    return false;
  }
}

/**
 * Migrate all plaintext transcript files in a directory.
 */
export function migrateAllTranscriptsInDirectory(dirPath: string): number {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  
  let migratedCount = 0;
  
  try {
    const files = fs.readdirSync(dirPath);
    
    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      
      const filePath = path.join(dirPath, file);
      if (migrateTranscriptToEncrypted(filePath)) {
        migratedCount++;
      }
    }
  } catch (error) {
    console.error(`Failed to migrate transcripts in ${dirPath}:`, error);
  }
  
  return migratedCount;
}

/**
 * Check if a sessions.json file needs migration and migrate it.
 */
export function migrateSessionsJsonToEncrypted(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  // Check if already encrypted by reading first few bytes
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(100); // Enough to check for magic header
    fs.readSync(fd, buffer, 0, 100, 0);
    fs.closeSync(fd);
    
    const header = buffer.toString("utf8", 0, 100);
    if (header.includes("OPENCLAW_ENCRYPTED_V1")) {
      return true; // Already encrypted
    }
  } catch {
    // If we can't read, assume it needs migration
  }
  
  try {
    // Read the file
    const content = fs.readFileSync(filePath, "utf8");
    
    // Create backup
    const backupPath = `${filePath}.backup-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    
    // Encrypt using the file-encryption utility
    const { writeEncryptedFile } = require("./file-encryption.js");
    writeEncryptedFile(filePath, content, true);
    
    console.log(`Migrated ${filePath} to encrypted format (backup: ${backupPath})`);
    return true;
  } catch (error) {
    console.error(`Failed to migrate ${filePath}:`, error);
    return false;
  }
}
