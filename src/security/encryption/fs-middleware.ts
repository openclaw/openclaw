/**
 * File system middleware for transparent encryption.
 *
 * Provides drop-in replacements for fs.readFile and fs.writeFile
 * that automatically encrypt/decrypt when encryption is enabled.
 *
 * This allows gradual integration: existing code can be updated
 * to use these wrappers without changing the call signature.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { decrypt, encrypt, isEncrypted } from "./crypto.js";

/**
 * Encryption-aware context that holds the active keys.
 * Set once at startup, used for all subsequent file operations.
 */
let _activeWorkspaceKey: Buffer | null = null;
let _activeConfigKey: Buffer | null = null;

/**
 * Set the active encryption keys for this process.
 * Called during gateway startup after loading keys from Keychain.
 */
export function setActiveKeys(workspaceKey: Buffer | null, configKey: Buffer | null): void {
  _activeWorkspaceKey = workspaceKey;
  _activeConfigKey = configKey;
}

/**
 * Get the current active workspace key (or null if encryption is disabled).
 */
export function getActiveWorkspaceKey(): Buffer | null {
  return _activeWorkspaceKey;
}

/**
 * Get the current active config key (or null if encryption is disabled).
 */
export function getActiveConfigKey(): Buffer | null {
  return _activeConfigKey;
}

/**
 * Clear active keys (for testing or shutdown).
 */
export function clearActiveKeys(): void {
  _activeWorkspaceKey = null;
  _activeConfigKey = null;
}

/**
 * Read a file with automatic decryption if encrypted and keys are available.
 * Drop-in replacement for: fs.readFile(path, "utf-8")
 */
export async function readFileAutoDecrypt(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);

  if (isEncrypted(raw) && _activeWorkspaceKey) {
    return decrypt(raw, _activeWorkspaceKey).toString("utf-8");
  }

  return raw.toString("utf-8");
}

/**
 * Write a file with automatic encryption if keys are active.
 * Drop-in replacement for: fs.writeFile(path, content, "utf-8")
 */
export async function writeFileAutoEncrypt(filePath: string, content: string): Promise<void> {
  if (_activeWorkspaceKey) {
    const encrypted = encrypt(Buffer.from(content, "utf-8"), _activeWorkspaceKey);
    await fs.writeFile(filePath, encrypted.buffer);
  } else {
    await fs.writeFile(filePath, content, "utf-8");
  }
}

/**
 * Read a config file with automatic decryption using the config key.
 */
export async function readConfigAutoDecrypt(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);

  if (isEncrypted(raw) && _activeConfigKey) {
    return decrypt(raw, _activeConfigKey).toString("utf-8");
  }

  return raw.toString("utf-8");
}

/**
 * Write a config file with automatic encryption using the config key.
 */
export async function writeConfigAutoEncrypt(filePath: string, content: string): Promise<void> {
  if (_activeConfigKey) {
    const encrypted = encrypt(Buffer.from(content, "utf-8"), _activeConfigKey);
    await fs.writeFile(filePath, encrypted.buffer);
  } else {
    await fs.writeFile(filePath, content, "utf-8");
  }
}

/**
 * Synchronous version of readFileAutoDecrypt.
 * Used for config.yaml loading which uses readFileSync.
 */
export function readFileSyncAutoDecrypt(filePath: string): string {
  const raw = fsSync.readFileSync(filePath);

  if (isEncrypted(raw) && _activeWorkspaceKey) {
    return decrypt(raw, _activeWorkspaceKey).toString("utf-8");
  }

  return raw.toString("utf-8");
}

/**
 * Synchronous config read with auto-decryption using the config key.
 */
export function readConfigSyncAutoDecrypt(filePath: string): string {
  const raw = fsSync.readFileSync(filePath);

  if (isEncrypted(raw) && _activeConfigKey) {
    return decrypt(raw, _activeConfigKey).toString("utf-8");
  }

  return raw.toString("utf-8");
}
