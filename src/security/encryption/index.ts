/**
 * Workspace encryption module.
 *
 * Provides AES-256-GCM encryption for workspace files and config,
 * with macOS Keychain key storage and scrypt key derivation.
 */

// Core crypto
export { decrypt, decryptString, encrypt, encryptString, isEncrypted } from "./crypto.js";
export type { EncryptedBlob } from "./crypto.js";

// Key derivation
export { deriveKeys, generateSalt } from "./key-derivation.js";
export type { DerivedKeys } from "./key-derivation.js";

// Keychain
export {
  keychainClearAll,
  keychainDelete,
  keychainGet,
  keychainGetAll,
  keychainHasKeys,
  keychainSet,
  keychainStoreAll,
} from "./keychain.js";
export type { KeychainAccount } from "./keychain.js";

// File operations
export {
  migrateFileToEncrypted,
  migrateFileToPlaintext,
  migrateWorkspaceToEncrypted,
  readFileEncrypted,
  WORKSPACE_SENSITIVE_FILES,
  writeFileEncrypted,
} from "./workspace-fs.js";

// Metadata
export {
  createEncryptionMeta,
  isEncryptionConfigured,
  readEncryptionMeta,
  writeEncryptionMeta,
} from "./metadata.js";
export type { EncryptionMeta } from "./metadata.js";

// Setup / lifecycle
export { changePassword, disableEncryption, initEncryption, unlockFromKeychain } from "./setup.js";
export type { SetupResult } from "./setup.js";

// Transparent middleware
export {
  clearActiveKeys,
  getActiveConfigKey,
  getActiveWorkspaceKey,
  readConfigAutoDecrypt,
  readConfigSyncAutoDecrypt,
  readFileAutoDecrypt,
  readFileSyncAutoDecrypt,
  setActiveKeys,
  writeConfigAutoEncrypt,
  writeFileAutoEncrypt,
} from "./fs-middleware.js";

// Integration / bootstrap
export { bootstrapEncryption, shutdownEncryption } from "./integration.js";
export type { EncryptionBootstrapResult } from "./integration.js";
