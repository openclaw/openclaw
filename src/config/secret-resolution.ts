/**
 * Secret reference resolution for config values.
 *
 * Supports `${provider:secret-name}` and `${provider:secret-name#version}` syntax.
 * Provider must be lowercase. Secret names allow: [a-zA-Z0-9_\-/.]
 * Version pinning via #version suffix (default: latest).
 * Escape with `$${provider:name}` to produce literal `${provider:name}`.
 */

import { isPlainObject } from "../utils.js";
import { AwsSecretProvider } from "./aws-secret-provider.js";

// Matches ${provider:name} or ${provider:name#version}
// Provider: lowercase alpha. Name: alphanum, hyphens, underscores, slashes, dots.
// Version (optional): after #, alphanumeric.
const SECRET_REF_PATTERN = /\$\{([a-z]+):([a-zA-Z0-9_\-/.]+?)(?:#([a-zA-Z0-9]+))?\}/g;

/** Parsed secret reference. */
export interface SecretRef {
  provider: string;
  name: string;
  version?: string;
}

/** Configuration for the secrets section in openclaw.json. */
export type SecretsConfig = {
  providers?: Record<
    string,
    {
      project?: string;
      cacheTtlSeconds?: number;
      credentialsFile?: string;
      // AWS-specific
      region?: string;
      profile?: string;
      roleArn?: string;
      externalId?: string;
    }
  >;
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class SecretResolutionError extends Error {
  constructor(
    public readonly provider: string,
    public readonly secretName: string,
    public readonly configPath: string,
    cause?: Error,
  ) {
    super(
      `Failed to resolve secret "${provider}:${secretName}" at config path: ${configPath}${cause ? ` — ${cause.message}` : ""}`,
    );
    this.name = "SecretResolutionError";
    this.cause = cause;
  }
}

export class UnknownSecretProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly configPath: string,
  ) {
    super(`Unknown secret provider "${provider}" referenced at config path: ${configPath}`);
    this.name = "UnknownSecretProviderError";
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = { value: string; expiresAt: number };
const secretCache = new Map<string, CacheEntry>();

export function clearSecretCache(): void {
  secretCache.clear();
}

// ---------------------------------------------------------------------------
// SecretProvider interface
// ---------------------------------------------------------------------------

export interface SecretProvider {
  name: string;
  getSecret(name: string, version?: string): Promise<string>;
  setSecret(name: string, value: string): Promise<void>;
  listSecrets(): Promise<string[]>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// GcpSecretProvider
// ---------------------------------------------------------------------------

export class GcpSecretProvider implements SecretProvider {
  public readonly name = "gcp";
  private readonly project: string;
  private readonly cacheTtlMs: number;
  private readonly credentialsFile?: string;
  constructor(config: { project: string; cacheTtlSeconds?: number; credentialsFile?: string }) {
    this.project = config.project;
    this.cacheTtlMs = (config.cacheTtlSeconds ?? 300) * 1000;
    this.credentialsFile = config.credentialsFile;
  }

  private async getClient(): Promise<unknown> {
    try {
      const mod = await import("@google-cloud/secret-manager");
      const Ctor = mod.SecretManagerServiceClient;
      const opts = this.credentialsFile ? { keyFilename: this.credentialsFile } : {};
      // Support both `new Ctor(opts)` (real) and mock functions that don't support `new`
      try {
        return new (Ctor as unknown as new (o: Record<string, unknown>) => unknown)(opts);
      } catch {
        // Fallback for mock functions that don't support new operator
        return (Ctor as unknown as (o: Record<string, unknown>) => unknown)(opts);
      }
    } catch {
      throw new Error(
        "Please install @google-cloud/secret-manager to use GCP secrets: pnpm add @google-cloud/secret-manager",
      );
    }
  }

  async getSecret(secretName: string, version?: string): Promise<string> {
    const ver = version ?? "latest";
    const cacheKey = `gcp:${secretName}#${ver}`;
    const cached = secretCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const client = await this.getClient();
    const resourceName = `projects/${this.project}/secrets/${secretName}/versions/${ver}`;

    let response: { payload?: { data?: Uint8Array | string } } | undefined;
    try {
      [response] = await client.accessSecretVersion({ name: resourceName });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 5) {
        throw new Error(`Secret '${secretName}' not found in project '${this.project}'`, {
          cause: err,
        });
      }
      if (code === 7) {
        throw new Error(`Permission denied for secret '${secretName}'. Check IAM bindings.`, {
          cause: err,
        });
      }
      if (code === 4) {
        // Retry once
        try {
          const retryClient = await this.getClient();
          [response] = await retryClient.accessSecretVersion({ name: resourceName });
        } catch {
          if (cached) {
            return cached.value;
          }
          throw err;
        }
      } else {
        throw err;
      }
    }

    const payload = response?.payload?.data;
    if (!payload) {
      throw new Error(`Secret "${secretName}" has no payload data`);
    }

    const value =
      payload instanceof Uint8Array || Buffer.isBuffer(payload)
        ? Buffer.from(payload).toString("utf-8")
        : String(payload);

    secretCache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  async setSecret(secretName: string, value: string): Promise<void> {
    const client = await this.getClient();
    const parent = `projects/${this.project}`;

    try {
      await client.createSecret({
        parent,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
    } catch {
      // Secret may already exist; other errors will surface on addSecretVersion
    }

    await client.addSecretVersion({
      parent: `${parent}/secrets/${secretName}`,
      payload: { data: Buffer.from(value, "utf-8") },
    });
  }

  async listSecrets(): Promise<string[]> {
    const client = await this.getClient();
    const [secrets] = await client.listSecrets({
      parent: `projects/${this.project}`,
    });
    return (secrets || []).map((s: { name?: string }) => {
      const name: string = s.name || "";
      const parts = name.split("/");
      return parts[parts.length - 1];
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      await client.listSecrets({ parent: `projects/${this.project}` });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Reference detection & extraction
// ---------------------------------------------------------------------------

export function containsSecretReference(value: string): boolean {
  if (!value.includes("${")) {
    return false;
  }
  SECRET_REF_PATTERN.lastIndex = 0;
  return SECRET_REF_PATTERN.test(value);
}

/** Remove escaped refs before extraction so $${gcp:x} isn't treated as a ref. */
function stripEscapedRefs(value: string): string {
  return value.replace(/\$\$\{[a-z]+:[a-zA-Z0-9_\-/.]+(?:#[a-zA-Z0-9]+)?\}/g, "");
}

export function extractSecretReferences(obj: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  const seen = new Set<string>();

  function walk(value: unknown): void {
    if (typeof value === "string" && value.includes("${")) {
      const cleaned = stripEscapedRefs(value);
      SECRET_REF_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SECRET_REF_PATTERN.exec(cleaned)) !== null) {
        const key = `${match[1]}:${match[2]}${match[3] ? "#" + match[3] : ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          const ref: SecretRef = { provider: match[1], name: match[2] };
          if (match[3]) {
            ref.version = match[3];
          }
          refs.push(ref);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
    } else if (isPlainObject(value)) {
      for (const val of Object.values(value)) {
        walk(val);
      }
    }
  }

  walk(obj);
  return refs;
}

export function configNeedsSecretResolution(obj: unknown): boolean {
  return extractSecretReferences(obj).length > 0;
}

// ---------------------------------------------------------------------------
// Build providers
// ---------------------------------------------------------------------------

export function buildSecretProviders(
  secretsConfig: SecretsConfig | undefined,
): Map<string, SecretProvider> {
  const providers = new Map<string, SecretProvider>();
  if (!secretsConfig?.providers) {
    return providers;
  }

  for (const [name, config] of Object.entries(secretsConfig.providers)) {
    if (name === "gcp" && config && config.project) {
      providers.set(
        "gcp",
        new GcpSecretProvider(
          config as { project: string; cacheTtlSeconds?: number; credentialsFile?: string },
        ),
      );
    }
    if (name === "aws" && config && config.region) {
      providers.set(
        "aws",
        new AwsSecretProvider({
          region: config.region,
          cacheTtlSeconds: config.cacheTtlSeconds,
          profile: config.profile,
          credentialsFile: config.credentialsFile,
          roleArn: config.roleArn,
          externalId: config.externalId,
        }),
      );
    }
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Fetch a secret value, checking the shared cache first.
 * This cache layer sits above individual provider caches, ensuring that
 * the same secret is not fetched twice within a single resolution pass
 * regardless of which provider implementation is used.
 */
async function fetchWithCache(
  provider: SecretProvider,
  name: string,
  version: string | undefined,
  cacheTtlMs: number,
): Promise<string> {
  const cacheKey = `${provider.name}:${name}#${version ?? "latest"}`;
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const value = await provider.getSecret(name, version);
    secretCache.set(cacheKey, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  } catch (err) {
    // Stale-while-revalidate: if we have an expired entry, use it
    if (cached) {
      return cached.value;
    }
    throw err;
  }
}

async function resolveString(
  value: string,
  providers: Map<string, SecretProvider>,
  configPath: string,
  cacheTtlMs: number,
): Promise<string> {
  if (!value.includes("$")) {
    return value;
  }

  // Handle escaped refs first: replace $${ with a placeholder
  const ESCAPE_PLACEHOLDER = "___OPENCLAW_ESC___";
  let working = value.replace(/\$\$\{/g, ESCAPE_PLACEHOLDER);

  // Collect matches
  SECRET_REF_PATTERN.lastIndex = 0;
  const matches: Array<{ full: string; provider: string; name: string; version?: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = SECRET_REF_PATTERN.exec(working)) !== null) {
    const m: { full: string; provider: string; name: string; version?: string } = {
      full: match[0],
      provider: match[1],
      name: match[2],
    };
    if (match[3]) {
      m.version = match[3];
    }
    matches.push(m);
  }

  if (matches.length === 0) {
    // Restore escaped refs as literals
    return working.replaceAll(ESCAPE_PLACEHOLDER, "${");
  }

  // Resolve all in parallel
  const resolved = await Promise.all(
    matches.map(async ({ provider: pName, name, version, full }) => {
      const provider = providers.get(pName);
      if (!provider) {
        throw new UnknownSecretProviderError(pName, configPath);
      }
      try {
        const resolvedValue = await fetchWithCache(provider, name, version, cacheTtlMs);
        return { full, value: resolvedValue };
      } catch (err) {
        throw new SecretResolutionError(
          pName,
          name,
          configPath,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }),
  );

  for (const { full, value: sv } of resolved) {
    working = working.replace(full, sv);
  }

  // Restore escaped refs
  working = working.replaceAll(ESCAPE_PLACEHOLDER, "${");
  return working;
}

async function resolveAny(
  value: unknown,
  providers: Map<string, SecretProvider>,
  path: string,
  cacheTtlMs: number,
): Promise<unknown> {
  if (typeof value === "string") {
    return resolveString(value, providers, path, cacheTtlMs);
  }
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, i) => resolveAny(item, providers, `${path}[${i}]`, cacheTtlMs)),
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const resolved = await Promise.all(
      entries.map(async ([key, val]) => {
        const childPath = path ? `${path}.${key}` : key;
        return [key, await resolveAny(val, providers, childPath, cacheTtlMs)] as const;
      }),
    );
    return Object.fromEntries(resolved);
  }
  return value;
}

/**
 * Resolve all secret references in a config object.
 *
 * @param obj - Config object potentially containing `${provider:name}` references.
 * @param secretsConfig - The `secrets` section from openclaw.json.
 * @param providersOverride - Optional pre-built providers map (useful for testing).
 */
export async function resolveConfigSecrets(
  obj: unknown,
  secretsConfig: SecretsConfig | undefined,
  providersOverride?: Map<string, SecretProvider>,
): Promise<unknown> {
  const refs = extractSecretReferences(obj);

  // Default cache TTL: 5 minutes
  const defaultTtlMs = 300_000;
  const cacheTtlMs =
    secretsConfig?.providers?.gcp?.cacheTtlSeconds != null
      ? secretsConfig.providers.gcp.cacheTtlSeconds * 1000
      : defaultTtlMs;

  // Handle escaped refs even with no real refs
  if (refs.length === 0) {
    // Still need to process escaped refs
    return resolveAny(obj, new Map(), "", cacheTtlMs);
  }

  const providers = providersOverride ?? buildSecretProviders(secretsConfig);

  // Check all referenced providers exist
  for (const ref of refs) {
    if (!providers.has(ref.provider)) {
      throw new UnknownSecretProviderError(ref.provider, "(config)");
    }
  }

  return resolveAny(obj, providers, "", cacheTtlMs);
}
