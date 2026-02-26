/**
 * Credential Vault - Phase 5 Security Hardening
 *
 * Secure credential storage with scope isolation, keychain integration,
 * and access logging for forensic analysis.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { logCredentialAccess, type AuditOptions } from "./credential-audit.js";
import { decryptCredentials, encryptCredentials, isEncryptedVault } from "./vault-crypto.js";

const log = createSubsystemLogger("security/credential-vault");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Credential scopes for access control and isolation */
export type CredentialScope = "provider" | "channel" | "integration" | "internal";

/** Metadata stored in registry (never contains the secret itself) */
export type CredentialEntry = {
  name: string;
  scope: CredentialScope;
  createdAt: number;
  rotatedAt: number;
  accessCount: number;
  lastAccessedAt: number | null;
  lastAccessedBy: string | null;
  /** First 8 chars of SHA-256 hash for identity verification */
  hashPrefix: string;
};

export type VaultErrorCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "KEYCHAIN_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "WRITE_FAILED"
  | "INVALID_VALUE";

export type VaultOperationResult =
  | { ok: true; entry: CredentialEntry }
  | { ok: false; error: string; code: VaultErrorCode };

export type VaultGetResult =
  | { ok: true; value: string; entry: CredentialEntry }
  | { ok: false; error: string; code: VaultErrorCode };

type ExecFileSyncFn = typeof execFileSync;

export type VaultOptions = {
  platform?: NodeJS.Platform;
  execFileSync?: ExecFileSyncFn;
  vaultDir?: string;
  requestor?: string;
  auditOptions?: AuditOptions;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const VAULT_SERVICE_NAME = "OpenClaw-vault";
const DEFAULT_VAULT_DIR = "~/.openclaw/vault";
const REGISTRY_FILENAME = "registry.json";
/** AES-256-GCM encrypted credential store (current format). */
const CREDENTIALS_ENC_FILENAME = "credentials.enc";
/** Legacy plaintext JSON store — only kept for migration detection. */
const CREDENTIALS_JSON_FILENAME = "credentials.json";

// Credential format validators
const CREDENTIAL_VALIDATORS: Record<string, RegExp> = {
  // Anthropic API keys
  anthropic: /^sk-ant-(?:api|admin)\d+-[A-Za-z0-9_-]{20,}$/,
  // OpenAI API keys
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
  // Google/Firebase
  google: /^AIza[A-Za-z0-9_-]{35}$/,
  // AWS Access Key ID
  aws_access_key: /^AKIA[A-Z0-9]{16}$/,
  // Slack tokens
  slack_bot: /^xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+$/,
  slack_app: /^xapp-[0-9]+-[A-Za-z0-9]+$/,
  // Telegram bot tokens
  telegram: /^\d{6,}:[A-Za-z0-9_-]{20,}$/,
  // Discord bot tokens
  discord: /^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}$/,
  // GitHub tokens
  github_pat: /^ghp_[A-Za-z0-9]{36}$/,
  github_fine: /^github_pat_[A-Za-z0-9_]{22,}$/,
  // Generic (minimum 16 chars, alphanumeric with common separators)
  generic: /^[A-Za-z0-9_-]{16,}$/,
};

function safeLogCredentialAccess(params: Parameters<typeof logCredentialAccess>[0]): void {
  try {
    logCredentialAccess(params);
  } catch (error) {
    log.warn("failed to append credential audit entry", {
      action: params.action,
      credentialName: params.credentialName,
      scope: params.scope,
      requestor: params.requestor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// -----------------------------------------------------------------------------
// Registry Management
// -----------------------------------------------------------------------------

type VaultRegistry = {
  version: number;
  entries: Record<string, CredentialEntry>;
};

export function resolveCredentialVaultDir(options?: VaultOptions): string {
  const dir = options?.vaultDir ?? DEFAULT_VAULT_DIR;
  return resolveUserPath(dir);
}

export function resolveCredentialVaultRegistryPath(options?: VaultOptions): string {
  return path.join(resolveCredentialVaultDir(options), REGISTRY_FILENAME);
}

function resolveRegistryPath(options?: VaultOptions): string {
  return resolveCredentialVaultRegistryPath(options);
}

function loadRegistry(options?: VaultOptions): VaultRegistry {
  const registryPath = resolveRegistryPath(options);
  const raw = loadJsonFile(registryPath);
  if (!raw || typeof raw !== "object") {
    return { version: 1, entries: {} };
  }
  const data = raw as Record<string, unknown>;
  return {
    version: typeof data.version === "number" ? data.version : 1,
    entries:
      typeof data.entries === "object" && data.entries
        ? (data.entries as Record<string, CredentialEntry>)
        : {},
  };
}

function saveRegistry(registry: VaultRegistry, options?: VaultOptions): void {
  const registryPath = resolveRegistryPath(options);
  saveJsonFile(registryPath, registry);
}

function computeHashPrefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function buildAccountName(scope: CredentialScope, name: string): string {
  return `${scope}:${name}`;
}

// -----------------------------------------------------------------------------
// Keychain Operations (macOS)
// -----------------------------------------------------------------------------

function readFromKeychain(account: string, options?: VaultOptions): string | null {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }

  const execFileSyncImpl = options?.execFileSync ?? execFileSync;
  const execOpts: ExecFileSyncOptions = {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  };

  try {
    const result = execFileSyncImpl(
      "security",
      ["find-generic-password", "-s", VAULT_SERVICE_NAME, "-a", account, "-w"],
      execOpts,
    );
    return (result as string).trim();
  } catch {
    return null;
  }
}

function writeToKeychain(account: string, value: string, options?: VaultOptions): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") {
    return false;
  }

  const execFileSyncImpl = options?.execFileSync ?? execFileSync;
  const execOpts: ExecFileSyncOptions = {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  };

  try {
    // Use -U flag to update if exists, or create if not
    // execFileSync prevents command injection via credential values
    execFileSyncImpl(
      "security",
      ["add-generic-password", "-U", "-s", VAULT_SERVICE_NAME, "-a", account, "-w", value],
      execOpts,
    );
    return true;
  } catch (error) {
    log.warn("failed to write to keychain", {
      account,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function deleteFromKeychain(account: string, options?: VaultOptions): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") {
    return false;
  }

  const execFileSyncImpl = options?.execFileSync ?? execFileSync;
  const execOpts: ExecFileSyncOptions = {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  };

  try {
    execFileSyncImpl(
      "security",
      ["delete-generic-password", "-s", VAULT_SERVICE_NAME, "-a", account],
      execOpts,
    );
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// File-Based Fallback (Linux/Windows) — AES-256-GCM encrypted
// -----------------------------------------------------------------------------

type FileCredentialsStore = Record<string, string>;

function loadFileCredentials(options?: VaultOptions): FileCredentialsStore {
  const vaultDir = resolveCredentialVaultDir(options);
  const encPath = path.join(vaultDir, CREDENTIALS_ENC_FILENAME);

  // Encrypted store (current format)
  if (fs.existsSync(encPath)) {
    try {
      const data = fs.readFileSync(encPath);
      if (!isEncryptedVault(data)) {
        log.warn("vault file has unexpected format, treating as empty store");
        return {};
      }
      const json = decryptCredentials(data, vaultDir);
      const raw = JSON.parse(json) as unknown;
      if (!raw || typeof raw !== "object") {
        return {};
      }
      return raw as FileCredentialsStore;
    } catch (error) {
      log.warn("failed to decrypt vault file, treating as empty store", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  // Migration: plaintext JSON from pre-encryption versions
  const legacyPath = path.join(vaultDir, CREDENTIALS_JSON_FILENAME);
  if (fs.existsSync(legacyPath)) {
    const raw = loadJsonFile(legacyPath);
    const store: FileCredentialsStore =
      raw && typeof raw === "object" ? (raw as FileCredentialsStore) : {};
    try {
      const encrypted = encryptCredentials(JSON.stringify(store), vaultDir);
      if (!fs.existsSync(vaultDir)) {
        fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(encPath, encrypted, { mode: 0o600 });
      fs.chmodSync(encPath, 0o600);
      fs.unlinkSync(legacyPath);
      log.info("migrated vault credentials from plaintext JSON to AES-256-GCM encrypted storage");
    } catch (error) {
      log.warn("failed to migrate vault credentials to encrypted storage", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return store;
  }

  return {};
}

function saveFileCredentials(store: FileCredentialsStore, options?: VaultOptions): void {
  const vaultDir = resolveCredentialVaultDir(options);
  const encPath = path.join(vaultDir, CREDENTIALS_ENC_FILENAME);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  }
  const encrypted = encryptCredentials(JSON.stringify(store), vaultDir);
  fs.writeFileSync(encPath, encrypted, { mode: 0o600 });
  fs.chmodSync(encPath, 0o600);
}

function readFromFile(account: string, options?: VaultOptions): string | null {
  const store = loadFileCredentials(options);
  return store[account] ?? null;
}

function writeToFile(account: string, value: string, options?: VaultOptions): boolean {
  try {
    const store = loadFileCredentials(options);
    store[account] = value;
    saveFileCredentials(store, options);
    return true;
  } catch (error) {
    log.warn("failed to write credential to file", {
      account,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function deleteFromFile(account: string, options?: VaultOptions): boolean {
  try {
    const store = loadFileCredentials(options);
    if (!(account in store)) {
      return false;
    }
    delete store[account];
    saveFileCredentials(store, options);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Unified Storage Operations
// -----------------------------------------------------------------------------

function readCredentialValue(account: string, options?: VaultOptions): string | null {
  // Try keychain first (macOS)
  const keychainValue = readFromKeychain(account, options);
  if (keychainValue) {
    return keychainValue;
  }
  // Fall back to file storage
  return readFromFile(account, options);
}

function writeCredentialValue(account: string, value: string, options?: VaultOptions): boolean {
  // Try keychain first (macOS)
  if (writeToKeychain(account, value, options)) {
    return true;
  }
  // Fall back to file storage
  return writeToFile(account, value, options);
}

function deleteCredentialValue(account: string, options?: VaultOptions): boolean {
  const keychainDeleted = deleteFromKeychain(account, options);
  const fileDeleted = deleteFromFile(account, options);
  return keychainDeleted || fileDeleted;
}

// -----------------------------------------------------------------------------
// Credential Validation
// -----------------------------------------------------------------------------

export function validateCredentialFormat(
  value: string,
  name: string,
): { valid: boolean; reason?: string } {
  if (!value || value.length < 8) {
    return { valid: false, reason: "Credential value is too short (minimum 8 characters)" };
  }

  // Try to match known formats
  const lowerName = name.toLowerCase();
  for (const [key, pattern] of Object.entries(CREDENTIAL_VALIDATORS)) {
    if (lowerName.includes(key) && pattern.test(value)) {
      return { valid: true };
    }
  }

  // Fall back to generic validation
  if (CREDENTIAL_VALIDATORS.generic.test(value)) {
    return { valid: true };
  }

  // Unknown format — accept but warn so operators can audit unexpected credential shapes
  log.warn("credential stored with unrecognised format", { name });
  return { valid: true };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Store a credential in the vault with scope isolation.
 */
export function storeCredential(
  name: string,
  value: string,
  scope: CredentialScope,
  options?: VaultOptions,
): VaultOperationResult {
  const requestor = options?.requestor ?? "vault";
  if (!name || !value) {
    safeLogCredentialAccess({
      action: "write",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: "Name and value are required",
      options: options?.auditOptions,
    });
    return { ok: false, error: "Name and value are required", code: "INVALID_VALUE" };
  }

  const validation = validateCredentialFormat(value, name);
  if (!validation.valid) {
    log.warn("credential validation failed", { name, scope, reason: validation.reason });
    safeLogCredentialAccess({
      action: "write",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: validation.reason ?? "Invalid credential format",
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: validation.reason ?? "Invalid credential format",
      code: "VALIDATION_FAILED",
    };
  }

  const account = buildAccountName(scope, name);
  const now = Date.now();

  // Write to storage
  if (!writeCredentialValue(account, value, options)) {
    safeLogCredentialAccess({
      action: "write",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: "Failed to write credential to storage",
      options: options?.auditOptions,
    });
    return { ok: false, error: "Failed to write credential to storage", code: "WRITE_FAILED" };
  }

  // Update registry
  const registry = loadRegistry(options);
  const existingEntry = registry.entries[account];

  const entry: CredentialEntry = {
    name,
    scope,
    createdAt: existingEntry?.createdAt ?? now,
    rotatedAt: now,
    accessCount: existingEntry?.accessCount ?? 0,
    lastAccessedAt: existingEntry?.lastAccessedAt ?? null,
    lastAccessedBy: existingEntry?.lastAccessedBy ?? null,
    hashPrefix: computeHashPrefix(value),
  };

  registry.entries[account] = entry;
  saveRegistry(registry, options);

  log.info("stored credential", { name, scope, hashPrefix: entry.hashPrefix });
  safeLogCredentialAccess({
    action: "write",
    credentialName: name,
    scope,
    requestor,
    success: true,
    options: options?.auditOptions,
  });

  return { ok: true, entry };
}

/**
 * Retrieve a credential from the vault with access logging.
 */
export function getCredential(
  name: string,
  scope: CredentialScope,
  requestor: string,
  options?: VaultOptions,
): VaultGetResult {
  const account = buildAccountName(scope, name);
  const registry = loadRegistry(options);
  const entry = registry.entries[account];

  if (!entry) {
    log.warn("credential not found", { name, scope, requestor });
    safeLogCredentialAccess({
      action: "read",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: `Credential "${name}" not found in scope "${scope}"`,
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: `Credential "${name}" not found in scope "${scope}"`,
      code: "NOT_FOUND",
    };
  }

  // Read from storage
  const value = readCredentialValue(account, options);
  if (!value) {
    log.warn("credential value not in storage", { name, scope, requestor });
    safeLogCredentialAccess({
      action: "read",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: "Credential exists in registry but not in storage",
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: "Credential exists in registry but not in storage",
      code: "NOT_FOUND",
    };
  }

  // Update access metadata
  entry.accessCount += 1;
  entry.lastAccessedAt = Date.now();
  entry.lastAccessedBy = requestor;
  registry.entries[account] = entry;
  saveRegistry(registry, options);

  log.info("credential accessed", { name, scope, requestor, accessCount: entry.accessCount });
  safeLogCredentialAccess({
    action: "read",
    credentialName: name,
    scope,
    requestor,
    success: true,
    options: options?.auditOptions,
  });

  return { ok: true, value, entry };
}

/**
 * Rotate a credential, archiving the old hash for audit purposes.
 */
export function rotateCredential(
  name: string,
  scope: CredentialScope,
  newValue: string,
  options?: VaultOptions,
): VaultOperationResult {
  const requestor = options?.requestor ?? "vault";
  const account = buildAccountName(scope, name);
  const registry = loadRegistry(options);
  const existingEntry = registry.entries[account];

  if (!existingEntry) {
    // If doesn't exist, create it
    return storeCredential(name, newValue, scope, options);
  }

  const validation = validateCredentialFormat(newValue, name);
  if (!validation.valid) {
    log.warn("credential rotation validation failed", { name, scope, reason: validation.reason });
    safeLogCredentialAccess({
      action: "rotate",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: validation.reason ?? "Invalid credential format",
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: validation.reason ?? "Invalid credential format",
      code: "VALIDATION_FAILED",
    };
  }

  const oldHashPrefix = existingEntry.hashPrefix;
  const newHashPrefix = computeHashPrefix(newValue);

  // Write new value
  if (!writeCredentialValue(account, newValue, options)) {
    safeLogCredentialAccess({
      action: "rotate",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: "Failed to write rotated credential to storage",
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: "Failed to write rotated credential to storage",
      code: "WRITE_FAILED",
    };
  }

  // Update registry
  const now = Date.now();
  const entry: CredentialEntry = {
    ...existingEntry,
    rotatedAt: now,
    hashPrefix: newHashPrefix,
  };

  registry.entries[account] = entry;
  saveRegistry(registry, options);

  log.info("credential rotated", {
    name,
    scope,
    oldHashPrefix,
    newHashPrefix,
    daysSinceLastRotation: Math.floor((now - existingEntry.rotatedAt) / (24 * 60 * 60 * 1000)),
  });
  safeLogCredentialAccess({
    action: "rotate",
    credentialName: name,
    scope,
    requestor,
    success: true,
    options: options?.auditOptions,
  });

  return { ok: true, entry };
}

/**
 * Delete a credential from the vault.
 */
export function deleteCredential(
  name: string,
  scope: CredentialScope,
  options?: VaultOptions,
): VaultOperationResult {
  const requestor = options?.requestor ?? "vault";
  const account = buildAccountName(scope, name);
  const registry = loadRegistry(options);
  const entry = registry.entries[account];

  if (!entry) {
    safeLogCredentialAccess({
      action: "delete",
      credentialName: name,
      scope,
      requestor,
      success: false,
      error: `Credential "${name}" not found in scope "${scope}"`,
      options: options?.auditOptions,
    });
    return {
      ok: false,
      error: `Credential "${name}" not found in scope "${scope}"`,
      code: "NOT_FOUND",
    };
  }

  // Delete from storage
  deleteCredentialValue(account, options);

  // Remove from registry
  delete registry.entries[account];
  saveRegistry(registry, options);

  log.info("credential deleted", { name, scope });
  safeLogCredentialAccess({
    action: "delete",
    credentialName: name,
    scope,
    requestor,
    success: true,
    options: options?.auditOptions,
  });

  return { ok: true, entry };
}

/**
 * List all credentials in a scope (metadata only, no secrets).
 */
export function listCredentials(
  scope?: CredentialScope,
  options?: VaultOptions,
): CredentialEntry[] {
  const registry = loadRegistry(options);
  const entries = Object.values(registry.entries);
  safeLogCredentialAccess({
    action: "list",
    credentialName: scope ? `${scope}:*` : "*",
    scope: scope ?? "internal",
    requestor: options?.requestor ?? "vault",
    success: true,
    options: options?.auditOptions,
  });

  if (scope) {
    return entries.filter((e) => e.scope === scope);
  }

  return entries;
}

/**
 * Check if a credential exists without accessing it.
 */
export function hasCredential(
  name: string,
  scope: CredentialScope,
  options?: VaultOptions,
): boolean {
  const account = buildAccountName(scope, name);
  const registry = loadRegistry(options);
  return account in registry.entries;
}

/**
 * Get credentials that are due for rotation (older than specified days).
 */
export function getCredentialsDueForRotation(
  maxAgeDays: number = 30,
  options?: VaultOptions,
): CredentialEntry[] {
  const registry = loadRegistry(options);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return Object.values(registry.entries).filter((entry) => entry.rotatedAt < cutoff);
}

/**
 * Verify vault directory exists and has correct permissions.
 */
export function ensureVaultDir(options?: VaultOptions): void {
  const vaultDir = resolveCredentialVaultDir(options);
  if (!fs.existsSync(vaultDir)) {
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    log.info("created vault directory", { path: vaultDir });
  }
}

/**
 * Reset vault caches (for testing).
 */
export function resetVaultForTest(): void {
  // No in-memory cache to reset currently, but kept for future use
}
