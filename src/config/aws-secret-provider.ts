/**
 * AWS Secrets Manager provider for OpenClaw.
 *
 * SDK (`@aws-sdk/client-secrets-manager`) is lazy-loaded as an optional peer dependency.
 * Authentication follows the AWS credential chain: env vars → shared credentials → IAM role → instance profile.
 */

import { type SecretProvider } from "./secret-resolution.js";

// ---------------------------------------------------------------------------
// Types (minimal — avoids importing SDK at module level)
// ---------------------------------------------------------------------------

interface AwsSmClient {
  send(command: unknown): Promise<any>;
}

export interface AwsProviderConfig {
  region: string;
  cacheTtlSeconds?: number;
  profile?: string;
  credentialsFile?: string;
  roleArn?: string;
  externalId?: string;
}

export interface AwsSecretDescription {
  name: string;
  lastRotatedDate?: Date;
  rotationEnabled?: boolean;
  rotationRules?: { automaticallyAfterDays?: number };
  tags: Record<string, string>;
}

// Cache for internal use (provider-level, separate from shared cache in secret-resolution.ts)
type CacheEntry = { value: string; expiresAt: number };
const localCache = new Map<string, CacheEntry>();

/** Clear the provider-level cache (for testing). */
export function clearAwsSecretCache(): void {
  localCache.clear();
}

// ---------------------------------------------------------------------------
// AwsSecretProvider
// ---------------------------------------------------------------------------

export class AwsSecretProvider implements SecretProvider {
  public readonly name = "aws";
  private readonly region: string;
  private readonly cacheTtlMs: number;
  private readonly profile?: string;
  private readonly credentialsFile?: string;
  private readonly roleArn?: string;
  private readonly externalId?: string;

  constructor(config: AwsProviderConfig) {
    this.region = config.region;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;
    this.profile = config.profile;
    this.credentialsFile = config.credentialsFile;
    this.roleArn = config.roleArn;
    this.externalId = config.externalId;
  }

  // -------------------------------------------------------------------------
  // SDK access (lazy-loaded)
  // -------------------------------------------------------------------------

  private clientInstance?: AwsSmClient;
  private sdkModule?: any;

  private async getSdk(): Promise<any> {
    if (this.sdkModule) {
      return this.sdkModule;
    }
    try {
      this.sdkModule = await import("@aws-sdk/client-secrets-manager");
      return this.sdkModule;
    } catch {
      throw new Error(
        "Please install @aws-sdk/client-secrets-manager: pnpm add @aws-sdk/client-secrets-manager",
      );
    }
  }

  private async getClient(): Promise<AwsSmClient> {
    if (this.clientInstance) {
      return this.clientInstance;
    }
    const sdk = await this.getSdk();
    const opts: Record<string, unknown> = { region: this.region };

    // Credential chain configuration
    if (this.profile) {
      opts.profile = this.profile;
    }

    this.clientInstance = new sdk.SecretsManagerClient(opts) as AwsSmClient;
    return this.clientInstance;
  }

  // -------------------------------------------------------------------------
  // SecretProvider interface
  // -------------------------------------------------------------------------

  async getSecret(secretName: string, version?: string): Promise<string> {
    // Check local cache
    const ver = version ?? "latest";
    const cacheKey = `aws:${secretName}#${ver}`;
    const cached = localCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const sdk = await this.getSdk();
    const client = await this.getClient();

    const params: Record<string, string> = { SecretId: secretName };
    if (version) {
      params.VersionId = version;
      params.VersionStage = version;
    }

    let response: any;
    try {
      response = await client.send(new sdk.GetSecretValueCommand(params));
    } catch (err: unknown) {
      const errName = (err as any)?.name;

      if (errName === "ResourceNotFoundException") {
        throw new Error(`Secret '${secretName}' not found in region '${this.region}'`, {
          cause: err,
        });
      }
      if (errName === "AccessDeniedException") {
        throw new Error(`Permission denied for secret '${secretName}'. Check IAM policy.`, {
          cause: err,
        });
      }
      if (errName === "DecryptionFailureException") {
        throw new Error(`Cannot decrypt secret '${secretName}'. Check KMS permissions.`, {
          cause: err,
        });
      }
      if (errName === "InvalidRequestException") {
        throw new Error(`Invalid request for secret '${secretName}': ${(err as Error).message}`, {
          cause: err,
        });
      }

      // Network / unknown error — stale-while-revalidate
      if (cached) {
        return cached.value;
      }
      throw err;
    }

    // Extract value
    let value: string;
    if (response.SecretString) {
      value = response.SecretString;
    } else if (response.SecretBinary) {
      value = Buffer.from(response.SecretBinary).toString("utf-8");
    } else {
      throw new Error(`Secret "${secretName}" has no payload data`);
    }

    localCache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  async setSecret(secretName: string, value: string): Promise<void> {
    const sdk = await this.getSdk();
    const client = await this.getClient();

    try {
      // Try PutSecretValue first (secret already exists)
      await client.send(
        new sdk.PutSecretValueCommand({
          SecretId: secretName,
          SecretString: value,
        }),
      );
    } catch (err: unknown) {
      if ((err as any)?.name === "ResourceNotFoundException") {
        // Secret doesn't exist — create it, then put value
        await client.send(
          new sdk.CreateSecretCommand({
            Name: secretName,
            SecretString: value,
          }),
        );
        // CreateSecret already stores the value, but if we want to be explicit:
        await client.send(
          new sdk.PutSecretValueCommand({
            SecretId: secretName,
            SecretString: value,
          }),
        );
      } else {
        throw err;
      }
    }
  }

  async listSecrets(): Promise<string[]> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const names: string[] = [];
    let nextToken: string | undefined;

    do {
      const params: Record<string, unknown> = {};
      if (nextToken) {
        params.NextToken = nextToken;
      }

      const response = await client.send(new sdk.ListSecretsCommand(params));
      for (const secret of response.SecretList ?? []) {
        if (secret.Name) {
          names.push(secret.Name);
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);

    return names;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const sdk = await this.getSdk();
      const client = await this.getClient();
      await client.send(new sdk.ListSecretsCommand({ MaxResults: 1 }));
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Rotation / tag support (extends beyond base SecretProvider interface)
  // -------------------------------------------------------------------------

  async describeSecret(secretName: string): Promise<AwsSecretDescription> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const response = await client.send(new sdk.DescribeSecretCommand({ SecretId: secretName }));

    const tags: Record<string, string> = {};
    for (const tag of response.Tags ?? []) {
      if (tag.Key && tag.Value !== undefined) {
        tags[tag.Key] = tag.Value;
      }
    }

    return {
      name: response.Name ?? secretName,
      lastRotatedDate: response.LastRotatedDate,
      rotationEnabled: response.RotationEnabled,
      rotationRules: response.RotationRules
        ? { automaticallyAfterDays: response.RotationRules.AutomaticallyAfterDays }
        : undefined,
      tags,
    };
  }

  async getTags(secretName: string): Promise<Record<string, string>> {
    const desc = await this.describeSecret(secretName);
    return desc.tags;
  }

  async setTags(secretName: string, tags: Record<string, string>): Promise<void> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    await client.send(
      new sdk.TagResourceCommand({
        SecretId: secretName,
        Tags: tagList,
      }),
    );
  }
}
