/**
 * Doppler secrets provider (stub).
 *
 * Doppler is popular for CLI/server environments with automatic secret syncing.
 *
 * TODO: Implement using Doppler CLI (`doppler secrets get`) or Doppler REST API.
 * Reference: https://docs.doppler.com/docs/api
 *
 * Note: No implementation provided — we don't currently have access to a Doppler account.
 * Contributions welcome!
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";
import { SecretsProviderError } from "./errors.js";

/** Options for the Doppler secrets provider. */
export interface DopplerSecretsProviderOptions {
  /** Doppler project name. */
  project?: string;
  /** Doppler config/environment (e.g. "dev", "staging", "prod"). */
  config?: string;
}

/**
 * Creates a Doppler secrets provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createDopplerSecretsProvider(
  _options: DopplerSecretsProviderOptions = {},
): SecretsProvider {
  return {
    name: "doppler",
    async resolve(_secretName: string): Promise<string> {
      throw new SecretsProviderError(
        "Doppler secrets provider is not yet implemented — no access to a Doppler account. " +
          "Contributions welcome — see src/config/secrets/doppler.ts",
      );
    },
  };
}
