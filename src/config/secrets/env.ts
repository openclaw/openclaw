/**
 * Environment variable secrets provider.
 *
 * Resolves secret names by looking them up as environment variables.
 * Useful as a simple local-dev fallback.
 */

import type { SecretsProvider } from "./provider.js";

/**
 * Creates an environment variable secrets provider.
 * Secret names are used directly as env var names.
 */
export function createEnvSecretsProvider(env: NodeJS.ProcessEnv = process.env): SecretsProvider {
  return {
    name: "env",
    async resolve(secretName: string): Promise<string> {
      const value = env[secretName];
      if (value === undefined || value === "") {
        throw new Error(`Secret "${secretName}" not found in environment variables`);
      }
      return value;
    },
  };
}
