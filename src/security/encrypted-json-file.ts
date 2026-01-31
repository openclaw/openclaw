import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { CredentialVault } from "./credential-vault.js";
import { createKeyProvider } from "./key-management.js";

let _vault: CredentialVault | null = null;
let _encryptionExplicitlyDisabled = false;

async function getVault(): Promise<CredentialVault | null> {
  // If encryption was explicitly disabled, return null
  if (_encryptionExplicitlyDisabled) return null;

  if (_vault) return _vault;

  try {
    const keyProvider = await createKeyProvider();
    _vault = new CredentialVault(keyProvider);
    return _vault;
  } catch {
    // If encryption setup fails, continue without encryption
    return null;
  }
}

/**
 * Load a JSON file, automatically decrypting if it's encrypted
 */
export async function loadEncryptedJsonFile(pathname: string): Promise<unknown> {
  const data = loadJsonFile(pathname);
  if (!data) return data;

  const vault = await getVault();
  if (vault && (await vault.isEncrypted(data))) {
    // Decryption failures should propagate - don't silently return encrypted data
    return await vault.decrypt(data as any);
  }
  return data;
}

/**
 * Save data to a JSON file, automatically encrypting if encryption is enabled
 */
export async function saveEncryptedJsonFile(pathname: string, data: unknown): Promise<void> {
  const vault = await getVault();
  if (vault) {
    // Encryption failures should propagate - don't silently save unencrypted
    const encrypted = await vault.encrypt(data);
    saveJsonFile(pathname, encrypted);
    return;
  }

  // No vault configured - save plaintext (encryption not enabled)
  saveJsonFile(pathname, data);
}

/**
 * Check if a file contains encrypted data
 */
export async function isFileEncrypted(pathname: string): Promise<boolean> {
  try {
    const data = loadJsonFile(pathname);
    const vault = await getVault();
    return Boolean(data && vault && (await vault.isEncrypted(data)));
  } catch {
    return false;
  }
}

/**
 * Enable or disable encryption by setting the vault instance
 * Mainly used for testing or manual configuration
 */
export function setEncryptionVault(vault: CredentialVault | null): void {
  _vault = vault;
  _encryptionExplicitlyDisabled = vault === null;
}

/**
 * Check if encryption is currently enabled
 */
export function isEncryptionEnabled(): boolean {
  return _vault !== null;
}
