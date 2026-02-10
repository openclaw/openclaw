/**
 * 1Password Secrets Automation provider (stub).
 *
 * TODO: Implement using `op://` URI resolution via 1Password CLI or Connect API
 * Reference: https://developer.1password.com/docs/connect/
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";
import { SecretsProviderError } from "./errors.js";

/**
 * Creates a 1Password secrets provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createOnePasswordSecretsProvider(): SecretsProvider {
  return {
    name: "1password",
    async resolve(_secretName: string): Promise<string> {
      throw new SecretsProviderError(
        "1Password secrets provider is not yet implemented. " +
          "Contributions welcome — see src/config/secrets/onepassword.ts",
      );
    },
  };
}
