/**
 * Vault Backend Abstraction for OpenClaw Secrets.
 *
 * Provides a unified interface for multiple secret storage backends:
 * - keychain (default): OS keychain via existing implementation
 * - 1password: 1Password CLI (future)
 * - bitwarden: Bitwarden CLI (future)
 * - vault: HashiCorp Vault (future)
 */

import { keychainGet, keychainSet, keychainDelete } from "./keychain.js";
import { getRegistry } from "./registry.js";

/**
 * Vault backend interface.
 */
export interface VaultBackend {
  /** Backend name for logging and error messages. */
  name: string;

  /**
   * Store a secret in the backend.
   */
  set(name: string, value: string): Promise<void>;

  /**
   * Retrieve a secret from the backend.
   * @returns Value or null if not found
   */
  get(name: string): Promise<string | null>;

  /**
   * Delete a secret from the backend.
   */
  delete(name: string): Promise<void>;

  /**
   * List all secret names in the backend.
   */
  list(): Promise<string[]>;
}

/**
 * Keychain backend (wraps existing keychain.ts implementation).
 */
class KeychainBackend implements VaultBackend {
  name = "keychain";

  async set(name: string, value: string): Promise<void> {
    await keychainSet(name, value);
  }

  async get(name: string): Promise<string | null> {
    return await keychainGet(name);
  }

  async delete(name: string): Promise<void> {
    await keychainDelete(name);
  }

  async list(): Promise<string[]> {
    // Keychain doesn't support list, use registry
    const registry = getRegistry();
    return registry.map((entry) => entry.name);
  }
}

/**
 * Factory for vault backends.
 * @param type Backend type ("keychain" | "1password" | "bitwarden" | "vault")
 * @returns Vault backend instance
 * @throws Error if backend type is not supported
 */
export function createVaultBackend(type: string): VaultBackend {
  switch (type) {
    case "keychain":
      return new KeychainBackend();
    case "1password":
      throw new Error("1Password backend not yet implemented");
    case "bitwarden":
      throw new Error("Bitwarden backend not yet implemented");
    case "vault":
      throw new Error("HashiCorp Vault backend not yet implemented");
    default:
      throw new Error(`Unknown vault backend: ${type}`);
  }
}
