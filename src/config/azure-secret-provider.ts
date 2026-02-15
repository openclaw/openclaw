/**
 * Azure Key Vault secret provider for OpenClaw.
 *
 * Uses `@azure/keyvault-secrets` + `@azure/identity` (lazy-loaded, optional peer deps).
 * Auth: DefaultAzureCredential chain (env vars, managed identity, Azure CLI, service principal).
 *
 * Config:
 *   secrets.providers.azure = {
 *     vaultUrl: "https://my-vault.vault.azure.net",
 *     tenantId?: string,
 *     clientId?: string,
 *     clientSecret?: string,
 *     credentialsFile?: string,
 *     cacheTtlSeconds?: number   // default 300
 *   }
 */

import type { SecretProvider } from "./secret-resolution.js";

// ---------------------------------------------------------------------------
// Types (mirrors Azure SDK types for testability)
// ---------------------------------------------------------------------------

export interface AzureSecretConfig {
  vaultUrl: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  credentialsFile?: string;
  cacheTtlSeconds?: number;
}

/** Minimal SecretClient interface for mocking. */
export interface AzureSecretClient {
  getSecret(
    name: string,
    options?: { version?: string },
  ): Promise<{ value?: string; properties: { version?: string; tags?: Record<string, string> } }>;
  setSecret(
    name: string,
    value: string,
    options?: { tags?: Record<string, string> },
  ): Promise<{ properties: { version?: string } }>;
  listPropertiesOfSecrets(): AsyncIterable<{ name: string }>;
}

/** Minimal credential interface. */
export interface AzureCredential {
  getToken(scope: string): Promise<{ token: string }>;
}

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

async function lazyImport<T>(pkg: string): Promise<T> {
  try {
    return await import(pkg);
  } catch {
    throw new Error(`Please install ${pkg}: pnpm add ${pkg}`);
  }
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

const AZURE_SECRET_NAME_RE = /^[a-zA-Z0-9-]+$/;

export function validateAzureSecretName(name: string): void {
  if (!AZURE_SECRET_NAME_RE.test(name)) {
    throw new Error(
      `Azure Key Vault secret names only allow alphanumeric characters and hyphens. Got: "${name}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapAzureError(err: unknown, secretName: string, vaultUrl: string): Error {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  const code = (err as { code?: string })?.code;

  if (statusCode === 404 || code === "SecretNotFound") {
    return new Error(`Secret '${secretName}' not found in vault '${vaultUrl}'`);
  }
  if (statusCode === 403 || code === "Forbidden") {
    return new Error(
      `Permission denied for secret '${secretName}'. Check Key Vault access policy or RBAC.`,
    );
  }
  if (code === "CredentialUnavailableError") {
    return new Error("Azure credentials not found. Run `az login` or set AZURE_* env vars.");
  }

  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// AzureSecretProvider
// ---------------------------------------------------------------------------

export class AzureSecretProvider implements SecretProvider {
  public readonly name = "azure";
  private readonly vaultUrl: string;
  private readonly cacheTtlMs: number;
  private readonly config: AzureSecretConfig;

  // Injected for testing; otherwise lazily created
  private _clientOverride?: AzureSecretClient;

  constructor(config: AzureSecretConfig, clientOverride?: AzureSecretClient) {
    this.vaultUrl = config.vaultUrl;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;
    this.config = config;
    this._clientOverride = clientOverride;
  }

  /** Cache TTL in ms — exposed for integration with shared fetchWithCache. */
  get cacheTtlMillis(): number {
    return this.cacheTtlMs;
  }

  private async getClient(): Promise<AzureSecretClient> {
    if (this._clientOverride) {
      return this._clientOverride;
    }

    const identityMod = await lazyImport<{
      DefaultAzureCredential: new () => AzureCredential;
      ClientSecretCredential: new (
        tenantId: string,
        clientId: string,
        clientSecret: string,
      ) => AzureCredential;
    }>("@azure/identity");

    const kvMod = await lazyImport<{
      SecretClient: new (url: string, credential: AzureCredential) => AzureSecretClient;
    }>("@azure/keyvault-secrets");

    let credential: AzureCredential;

    if (this.config.credentialsFile) {
      // Read credentials from file
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(this.config.credentialsFile, "utf-8");
      const creds = JSON.parse(raw) as {
        tenantId: string;
        clientId: string;
        clientSecret: string;
      };
      credential = new identityMod.ClientSecretCredential(
        creds.tenantId,
        creds.clientId,
        creds.clientSecret,
      );
    } else if (this.config.tenantId && this.config.clientId && this.config.clientSecret) {
      credential = new identityMod.ClientSecretCredential(
        this.config.tenantId,
        this.config.clientId,
        this.config.clientSecret,
      );
    } else {
      credential = new identityMod.DefaultAzureCredential();
    }

    return new kvMod.SecretClient(this.vaultUrl, credential);
  }

  async getSecret(secretName: string, version?: string): Promise<string> {
    validateAzureSecretName(secretName);

    const client = await this.getClient();
    try {
      const opts = version ? { version } : undefined;
      const result = await client.getSecret(secretName, opts);
      if (result.value === undefined) {
        throw new Error(`Secret "${secretName}" has no value`);
      }
      return result.value;
    } catch (err) {
      throw mapAzureError(err, secretName, this.vaultUrl);
    }
  }

  async setSecret(secretName: string, value: string): Promise<void> {
    validateAzureSecretName(secretName);

    const client = await this.getClient();
    try {
      await client.setSecret(secretName, value);
    } catch (err) {
      throw mapAzureError(err, secretName, this.vaultUrl);
    }
  }

  async listSecrets(): Promise<string[]> {
    const client = await this.getClient();
    const names: string[] = [];
    try {
      for await (const props of client.listPropertiesOfSecrets()) {
        if (props.name) {
          names.push(props.name);
        }
      }
    } catch (err) {
      throw mapAzureError(err, "(list)", this.vaultUrl);
    }
    return names;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      // Try to list at least one secret to verify connectivity + auth
      const iter = client.listPropertiesOfSecrets();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of iter) {
        break; // just need one iteration
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Rotation metadata helpers (Azure secret tags)
// ---------------------------------------------------------------------------

export type AzureRotationType = "auto" | "manual" | "dynamic";

export interface AzureRotationMetadata {
  rotationType: AzureRotationType;
  rotationIntervalDays: number;
  lastRotated?: Date;
  expiresAt?: Date;
  snoozedUntil?: Date;
}

export function parseAzureRotationTags(tags: Record<string, string>): AzureRotationMetadata {
  const VALID = new Set<AzureRotationType>(["auto", "manual", "dynamic"]);
  const rawType = tags["rotation-type"] as AzureRotationType | undefined;
  const rotationType: AzureRotationType = rawType && VALID.has(rawType) ? rawType : "manual";

  const rawInterval = parseInt(tags["rotation-interval-days"] ?? "", 10);
  const rotationIntervalDays = isNaN(rawInterval) || rawInterval <= 0 ? 90 : rawInterval;

  const parseDate = (s?: string): Date | undefined => {
    if (!s) {
      return undefined;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  };

  return {
    rotationType,
    rotationIntervalDays,
    lastRotated: parseDate(tags["last-rotated"]),
    expiresAt: parseDate(tags["expires-at"]),
    snoozedUntil: parseDate(tags["snoozed-until"]),
  };
}

export function buildAzureRotationTags(meta: AzureRotationMetadata): Record<string, string> {
  const tags: Record<string, string> = {
    "rotation-type": meta.rotationType,
    "rotation-interval-days": String(meta.rotationIntervalDays),
  };
  if (meta.lastRotated) {
    tags["last-rotated"] = meta.lastRotated.toISOString();
  }
  if (meta.expiresAt) {
    tags["expires-at"] = meta.expiresAt.toISOString();
  }
  if (meta.snoozedUntil) {
    tags["snoozed-until"] = meta.snoozedUntil.toISOString();
  }
  return tags;
}

/**
 * Check if a secret's version has changed (rotation detection via polling).
 * Compare cached version ID with current version from Key Vault.
 */
export async function checkSecretVersionChanged(
  client: AzureSecretClient,
  secretName: string,
  cachedVersion?: string,
): Promise<{ changed: boolean; currentVersion?: string }> {
  const result = await client.getSecret(secretName);
  const currentVersion = result.properties.version;
  if (!cachedVersion || !currentVersion) {
    return { changed: false, currentVersion };
  }
  return { changed: cachedVersion !== currentVersion, currentVersion };
}
