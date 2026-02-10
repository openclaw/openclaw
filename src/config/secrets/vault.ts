/**
 * HashiCorp Vault secrets provider (stub).
 *
 * HashiCorp Vault is the enterprise standard for secrets management.
 *
 * TODO: Implement using Vault HTTP API or node-vault package.
 * Reference: https://developer.hashicorp.com/vault/api-docs
 *
 * Note: No implementation provided — we don't currently have access to a Vault instance.
 * Contributions welcome!
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";
import { SecretsProviderError } from "./errors.js";

/** Options for the HashiCorp Vault secrets provider. */
export interface VaultSecretsProviderOptions {
  /** Vault server address (e.g. "https://vault.example.com:8200"). */
  address?: string;
  /** Vault namespace (enterprise feature). */
  namespace?: string;
  /** Secret engine mount path (default: "secret"). */
  mountPath?: string;
}

/**
 * Creates a HashiCorp Vault secrets provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createVaultSecretsProvider(
  _options: VaultSecretsProviderOptions = {},
): SecretsProvider {
  return {
    name: "vault",
    async resolve(_secretName: string): Promise<string> {
      throw new SecretsProviderError(
        "HashiCorp Vault secrets provider is not yet implemented — no access to a Vault instance. " +
          "Contributions welcome — see src/config/secrets/vault.ts",
      );
    },
  };
}
