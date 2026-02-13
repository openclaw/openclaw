import { openVault, type VaultOptions } from "./env-vault.js";

type VaultCliAction =
  | { action: "list" }
  | { action: "get"; key: string }
  | { action: "set"; key: string; value: string }
  | { action: "remove"; key: string };

/**
 * Run a vault CLI action programmatically. Returns a result string for display.
 */
export function runVaultAction(vaultAction: VaultCliAction, opts: VaultOptions): string {
  const vault = openVault(opts);
  try {
    switch (vaultAction.action) {
      case "list": {
        const keys = vault.listKeys();
        if (keys.length === 0) {
          return "Vault is empty.";
        }
        return keys.join("\n");
      }
      case "get": {
        const value = vault.get(vaultAction.key);
        if (value === null) {
          return `Key not found: ${vaultAction.key}`;
        }
        return value;
      }
      case "set": {
        vault.set(vaultAction.key, vaultAction.value);
        return `Stored: ${vaultAction.key}`;
      }
      case "remove": {
        const removed = vault.remove(vaultAction.key);
        if (removed) {
          return `Removed: ${vaultAction.key}`;
        }
        return `Key not found: ${vaultAction.key}`;
      }
    }
  } finally {
    vault.close();
  }
}
