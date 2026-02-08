/**
 * Google Cloud Secret Manager provider.
 *
 * Resolves secrets via the `@google-cloud/secret-manager` package using
 * Application Default Credentials (ADC). Secrets are cached for the lifetime
 * of the provider instance.
 *
 * NOTE: The `@google-cloud/secret-manager` package is NOT yet installed.
 * This module will fail at runtime until the dependency is added.
 */

import type { SecretsProvider } from "./provider.js";

/** Options for the GCP Secret Manager provider. */
export interface GcpSecretsProviderOptions {
  /** GCP project ID. Required — Secret Manager does not support automatic project discovery. */
  project: string;
}

export class GcpSecretsProviderError extends Error {
  constructor(
    message: string,
    public readonly secretName?: string,
  ) {
    super(message);
    this.name = "GcpSecretsProviderError";
  }
}

/** Shape of the GCP Secret Manager client we use. */
interface SecretManagerClient {
  accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: unknown } }]>;
}

/**
 * Creates a GCP Secret Manager secrets provider.
 *
 * @param options - Provider configuration
 * @returns A SecretsProvider backed by GCP Secret Manager
 */
export function createGcpSecretsProvider(options: GcpSecretsProviderOptions = {}): SecretsProvider {
  const cache = new Map<string, string>();
  let client: SecretManagerClient | null = null;

  async function getClient(): Promise<SecretManagerClient> {
    if (client) {
      return client;
    }
    try {
      // Dynamic import — will fail until @google-cloud/secret-manager is installed
      const mod = await import("@google-cloud/secret-manager" as string);
      const SecretManagerServiceClient =
        mod.SecretManagerServiceClient ?? mod.default?.SecretManagerServiceClient;
      if (!SecretManagerServiceClient) {
        throw new Error("SecretManagerServiceClient not found in module");
      }
      client = new SecretManagerServiceClient() as SecretManagerClient;
      return client;
    } catch (err) {
      throw new GcpSecretsProviderError(
        `Failed to load @google-cloud/secret-manager. Is it installed? ${String(err)}`,
      );
    }
  }

  function buildSecretPath(secretName: string): string {
    return `projects/${options.project}/secrets/${secretName}/versions/latest`;
  }

  return {
    name: "gcp",

    async resolve(secretName: string): Promise<string> {
      const cached = cache.get(secretName);
      if (cached !== undefined) {
        return cached;
      }

      const svc = await getClient();
      const secretPath = buildSecretPath(secretName);

      try {
        const [response] = await svc.accessSecretVersion({ name: secretPath });
        const payload = response.payload?.data;
        if (payload === undefined || payload === null) {
          throw new GcpSecretsProviderError(
            `Secret "${secretName}" has no payload data`,
            secretName,
          );
        }
        let value: string;
        if (typeof payload === "string") {
          value = payload;
        } else if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
          value = Buffer.from(payload).toString("utf-8");
        } else {
          throw new GcpSecretsProviderError(
            `Secret "${secretName}" has unexpected payload type: ${typeof payload}`,
            secretName,
          );
        }
        cache.set(secretName, value);
        return value;
      } catch (err) {
        if (err instanceof GcpSecretsProviderError) {
          throw err;
        }
        throw new GcpSecretsProviderError(
          `Failed to resolve secret "${secretName}": ${String(err)}`,
          secretName,
        );
      }
    },

    async dispose(): Promise<void> {
      // Clear cached secret values from memory
      cache.clear();
      client = null;
    },
  };
}
