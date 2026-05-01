import fs from "node:fs";
import { isLineEncrypted, decryptLine } from "./line-encryption.js";

/**
 * Read a transcript file, handling encryption transparently.
 */
export function readTranscriptFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const decryptedLines: string[] = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      decryptedLines.push(line);
      continue;
    }
    
    try {
      if (isLineEncrypted(line)) {
        const decrypted = decryptLine(line);
        decryptedLines.push(decrypted);
      } else {
        decryptedLines.push(line);
      }
    } catch (error) {
      console.error("Failed to decrypt line:", error);
      decryptedLines.push(line); // Keep as-is if decryption fails
    }
  }
  
  return decryptedLines.join("\n");
}

/**
 * Read transcript lines, handling encryption transparently.
 */
export function readTranscriptLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const decryptedLines: string[] = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      decryptedLines.push(line);
      continue;
    }
    
    try {
      if (isLineEncrypted(line)) {
        const decrypted = decryptLine(line);
        decryptedLines.push(decrypted);
      } else {
        decryptedLines.push(line);
      }
    } catch (error) {
      console.error("Failed to decrypt line:", error);
      decryptedLines.push(line); // Keep as-is if decryption fails
    }
  }
  
  return decryptedLines;
}

/**
 * Check if a file contains encrypted lines.
 */
export function isTranscriptEncrypted(filePath: string): boolean {
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
