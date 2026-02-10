/**
 * Bitwarden Secrets Manager provider (stub).
 *
 * Bitwarden is a popular open-source password/secrets manager.
 *
 * TODO: Implement using Bitwarden CLI (`bw get`) or Bitwarden Secrets Manager SDK.
 * Reference: https://bitwarden.com/help/secrets-manager-overview/
 *
 * Note: No implementation provided — we don't currently have access to a Bitwarden account.
 * Contributions welcome!
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";
import { SecretsProviderError } from "./errors.js";

/**
 * Creates a Bitwarden secrets provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createBitwardenSecretsProvider(): SecretsProvider {
  return {
    name: "bitwarden",
    async resolve(_secretName: string): Promise<string> {
      throw new SecretsProviderError(
        "Bitwarden secrets provider is not yet implemented — no access to a Bitwarden account. " +
          "Contributions welcome — see src/config/secrets/bitwarden.ts",
      );
    },
  };
}
