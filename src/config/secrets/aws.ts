/**
 * AWS Secrets Manager provider (stub).
 *
 * TODO: Implement using @aws-sdk/client-secrets-manager
 *
 * @throws Always throws — not yet implemented.
 */

import type { SecretsProvider } from "./provider.js";
import { SecretsProviderError } from "./errors.js";

/** Options for the AWS Secrets Manager provider. */
export interface AwsSecretsProviderOptions {
  /** AWS region. If omitted, uses the default region from AWS config. */
  region?: string;
}

/**
 * Creates an AWS Secrets Manager provider.
 * Currently a stub that throws on any resolution attempt.
 */
export function createAwsSecretsProvider(
  _options: AwsSecretsProviderOptions = {},
): SecretsProvider {
  return {
    name: "aws",
    async resolve(_secretName: string): Promise<string> {
      throw new SecretsProviderError(
        "AWS Secrets Manager provider is not yet implemented. " +
          "Contributions welcome — see src/config/secrets/aws.ts",
      );
    },
  };
}
