import type { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { encryptLine, decryptLine, isLineEncrypted } from "./line-encryption.js";
import { readTranscriptLines } from "./transcript-reader.js";

/**
 * Simplified wrapper around SessionManager that transparently encrypts/decrypts session files.
 * Avoids temp files by parsing JSON directly after decryption.
 */
export class EncryptedSessionManager {
  private sessionManager: SessionManager;
  private filePath: string;
  private isEncryptedCache: boolean | null = null;

  constructor(sessionManager: SessionManager, filePath: string) {
    this.sessionManager = sessionManager;
    this.filePath = filePath;
  }

  /**
   * Check if the session file is using encrypted format.
   */
  private checkIfEncrypted(): boolean {
    if (this.isEncryptedCache !== null) {
      return this.isEncryptedCache;
    }

    if (!fs.existsSync(this.filePath)) {
      this.isEncryptedCache = false;
      return false;
    }

    // Read first non-empty line to check format
    const content = fs.readFileSync(this.filePath, "utf8");
    const lines = content.split(/\r?\n/);
    
    for (const line of lines) {
      if (line.trim()) {
        this.isEncryptedCache = isLineEncrypted(line);
        return this.isEncryptedCache;
      }
    }
    
    this.isEncryptedCache = false;
    return false;
  }

  /**
   * Append a message with transparent encryption.
   */
  appendMessage(message: Parameters<SessionManager["appendMessage"]>[0]): string {
    const isEncrypted = this.checkIfEncrypted();
    
    if (isEncrypted) {
      // For encrypted files, append encrypted line directly
      return this.appendEncryptedMessage(message);
    } else {
      // For plaintext files, use SessionManager then convert to encrypted
      return this.appendPlaintextAndConvert(message);
    }
  }

  /**
   * Append a message to an encrypted file.
   */
  private appendEncryptedMessage(message: Parameters<SessionManager["appendMessage"]>[0]): string {
    // Generate a message ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Get current leaf ID for parent reference
    const leafId = this.getLeafId();
    
    // Create proper Pi session entry with type, parentId, and timestamp
    const entry = {
      type: "message" as const,
      id: messageId,
      parentId: leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    
    // Create the JSON line
    const line = JSON.stringify(entry);
    
    // Encrypt the line
    const encryptedLine = encryptLine(line);
    
    // Append to file
    fs.appendFileSync(this.filePath, encryptedLine + "\n", "utf8");
    
    return messageId;
  }

  /**
   * Append a message to a plaintext file and convert to encrypted format.
   */
  private appendPlaintextAndConvert(message: Parameters<SessionManager["appendMessage"]>[0]): string {
    // Use SessionManager to append (writes plaintext)
    const messageId = this.sessionManager.appendMessage(message);
    
    // Convert entire file to encrypted format
    this.convertFileToEncrypted();
    
    return messageId;
  }

  /**
   * Convert a plaintext file to encrypted format.
   * Fails closed: if any line fails to encrypt, the entire migration fails.
   */
  private convertFileToEncrypted(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    
    // Read all lines
    const content = fs.readFileSync(this.filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const encryptedLines: string[] = [];
    let hasErrors = false;
    
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
        hasErrors = true;
        break; // Stop on first error
      }
    }
    
    // Only write if all lines were successfully encrypted
    if (!hasErrors) {
      // Create backup first
      const backupPath = `${this.filePath}.backup-${Date.now()}`;
      fs.copyFileSync(this.filePath, backupPath);
      
      // Write back encrypted file
      fs.writeFileSync(this.filePath, encryptedLines.join("\n"), "utf8");
      
      // Update cache
      this.isEncryptedCache = true;
      console.log(`Successfully migrated ${this.filePath} to encrypted format (backup: ${backupPath})`);
    } else {
      console.error(`Failed to migrate ${this.filePath} to encrypted format due to encryption errors`);
      throw new Error("Failed to encrypt transcript file");
    }
  }

  /**
   * Get branch entries with transparent decryption.
   * Simplified: parse JSON directly instead of creating temp files.
   */
  getBranch(): any[] {
    const isEncrypted = this.checkIfEncrypted();
    
    if (!isEncrypted) {
      return this.sessionManager.getBranch();
    }
    
    // Read and decrypt lines
    const lines = readTranscriptLines(this.filePath);
    const entries: any[] = [];
    
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session") {
          // Skip session header
          continue;
        }
        entries.push(parsed);
      } catch (error) {
        console.error("Failed to parse line:", error);
      }
    }
    
    return entries;
  }

  /**
   * Get leaf ID.
   */
  getLeafId(): string {
    return this.sessionManager.getLeafId();
  }

  /**
   * Get CWD.
   */
  getCwd(): string {
    return this.sessionManager.getCwd();
  }

  /**
   * Get entries.
   * Simplified: parse JSON directly instead of creating temp files.
   */
  getEntries(): any[] {
    const isEncrypted = this.checkIfEncrypted();
    
    if (!isEncrypted) {
      return this.sessionManager.getEntries();
    }
    
    // Read and decrypt lines
    const lines = readTranscriptLines(this.filePath);
    const entries: any[] = [];
    
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      
      try {
        const parsed = JSON.parse(line);
        entries.push(parsed);
      } catch (error) {
        console.error("Failed to parse line:", error);
      }
    }
    
    return entries;
  }

  /**
   * Static method to open a session file with encryption support.
   */
  static open(filePath: string, cwd?: string): EncryptedSessionManager {
    const { SessionManager } = require("@mariozechner/pi-coding-agent");
    const sessionManager = SessionManager.open(filePath, cwd);
    return new EncryptedSessionManager(sessionManager, filePath);
  }

  /**
   * Static method to fork a session with encryption support.
   */
  static forkFrom(filePath: string, cwd?: string): EncryptedSessionManager {
    const { SessionManager } = require("@mariozechner/pi-coding-agent");
    const sessionManager = SessionManager.forkFrom(filePath, cwd);
    return new EncryptedSessionManager(sessionManager, filePath);
  }
}
