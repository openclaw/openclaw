export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/u;
const SECRET_REFERENCE_RE = /\$(?:([A-Z][A-Z0-9_]*)|\{([A-Z][A-Z0-9_]*)\})/gu;
const EXACT_ECHO_HEAD_RE = /^echo\s+\$[{]?([A-Z][A-Z0-9_]*)[}]?\s*\|\s*head\s+-c\s+([0-9]+)$/u;
const METADATA_CACHE_TTL_MS = 60_000;
const ALLOWED_CATEGORIES = new Set(["ssh_key", "api_key", "token", "env_var"]);

export type SecretCategory = "ssh_key" | "api_key" | "token" | "env_var";

export type ExactEchoHeadCommand = {
  name: string;
  count: number;
};

export type ResolveEnvelope = {
  resolved: Record<string, string>;
  categories: Record<string, SecretCategory>;
  missing: string[];
};

export type CandidateMetadata = {
  known: Record<string, { category: SecretCategory }>;
  unknown: string[];
};

export interface PlatformSecretsRuntimeClient {
  candidateMetadata(names: string[], tenantId: string): Promise<CandidateMetadata>;
  resolve(names: string[], tenantId: string, tool: string): Promise<ResolveEnvelope>;
}

type CacheEntry = {
  known: boolean;
  category?: SecretCategory;
  expiresAt: number;
};

const metadataCache = new Map<string, CacheEntry>();

export function parseExactEchoHeadCommand(command: string): ExactEchoHeadCommand | null {
  const match = EXACT_ECHO_HEAD_RE.exec(command.trim());
  if (!match) {
    return null;
  }
  const name = match[1] ?? "";
  const count = Number.parseInt(match[2] ?? "", 10);
  if (!SECRET_NAME_RE.test(name) || !Number.isInteger(count) || count < 1 || count > 64) {
    return null;
  }
  return { name, count };
}

export function extractSecretReferenceCandidates(command: string): string[] {
  const seen = new Set<string>();
  for (const match of command.matchAll(SECRET_REFERENCE_RE)) {
    const name = match[1] ?? match[2];
    if (name) {
      seen.add(name);
    }
  }
  return [...seen].toSorted();
}

export function resolveRuntimeTenantId(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROCKIELAB_TENANT_ID?.trim() ?? "";
}

function resolvePlatformBrokerToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROCKIELAB_BROKER_TOKEN?.trim() || env.BROKER_TENANT_TOKEN?.trim() || "";
}

function resolvePlatformApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ROCKIELAB_API_BASE?.trim() || "https://api.rockielab.com").replace(/\/+$/u, "");
}

function assertUniqueRequestedNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`Invalid secret name ${JSON.stringify(name)}.`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate secret name ${JSON.stringify(name)} is not allowed.`);
    }
    seen.add(name);
  }
}

function assertCategory(value: string, name: string): asserts value is SecretCategory {
  if (!ALLOWED_CATEGORIES.has(value)) {
    throw new Error(`Invalid secret category for ${name}.`);
  }
}

export function validateResolveEnvelope(params: {
  requested: string[];
  envelope: ResolveEnvelope;
  metadata?: Record<string, SecretCategory>;
}): ResolveEnvelope {
  assertUniqueRequestedNames(params.requested);
  const requested = new Set(params.requested);
  const resolvedNames = new Set<string>();
  for (const [name, value] of Object.entries(params.envelope.resolved ?? {})) {
    if (!requested.has(name)) {
      throw new Error(`Resolve returned unrequested secret ${name}.`);
    }
    if (!value) {
      throw new Error(`Resolve returned empty value for ${name}.`);
    }
    const category = params.envelope.categories?.[name];
    if (!category) {
      throw new Error(`Resolve omitted category for ${name}.`);
    }
    assertCategory(category, name);
    const cached = params.metadata?.[name];
    if (cached && cached !== category) {
      throw new Error(`Resolve category mismatch for ${name}.`);
    }
    resolvedNames.add(name);
  }
  const missingNames = new Set<string>();
  for (const name of params.envelope.missing ?? []) {
    if (!requested.has(name)) {
      throw new Error(`Resolve returned unrequested missing secret ${name}.`);
    }
    if (resolvedNames.has(name)) {
      throw new Error(`Resolve returned ${name} as both resolved and missing.`);
    }
    missingNames.add(name);
  }
  for (const name of requested) {
    if (!resolvedNames.has(name) && !missingNames.has(name)) {
      throw new Error(`Resolve omitted requested secret ${name}.`);
    }
    if (missingNames.has(name)) {
      throw new Error(`Secret ${name} is missing.`);
    }
  }
  for (const name of Object.keys(params.envelope.categories ?? {})) {
    if (!resolvedNames.has(name)) {
      throw new Error(`Resolve returned category for unresolved secret ${name}.`);
    }
  }
  return params.envelope;
}

export class FetchPlatformSecretsRuntimeClient implements PlatformSecretsRuntimeClient {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async candidateMetadata(names: string[], tenantId: string): Promise<CandidateMetadata> {
    return await this.post<CandidateMetadata>("/api/secrets/metadata", tenantId, { names });
  }

  async resolve(names: string[], tenantId: string, tool: string): Promise<ResolveEnvelope> {
    return await this.post<ResolveEnvelope>("/api/secrets/resolve", tenantId, { names, tool });
  }

  private async post<T>(path: string, tenantId: string, body: unknown): Promise<T> {
    if (!tenantId) {
      throw new Error("ROCKIELAB_TENANT_ID is required for secret runtime operations.");
    }
    const token = resolvePlatformBrokerToken(this.env);
    if (!token) {
      throw new Error("Broker token is required for secret runtime operations.");
    }
    const response = await fetch(`${resolvePlatformApiBase(this.env)}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Platform secrets API ${path} failed: ${text.trim() || response.status}`);
    }
    return (await response.json()) as T;
  }
}

export async function getCachedCandidateMetadata(params: {
  names: string[];
  tenantId: string;
  client: PlatformSecretsRuntimeClient;
  nowMs?: number;
}): Promise<Record<string, SecretCategory>> {
  const now = params.nowMs ?? Date.now();
  const out: Record<string, SecretCategory> = {};
  const missing: string[] = [];
  for (const name of params.names) {
    const key = `${params.tenantId}\0${name}`;
    const cached = metadataCache.get(key);
    if (cached && cached.expiresAt > now) {
      if (cached.known && cached.category) {
        out[name] = cached.category;
      }
      continue;
    }
    missing.push(name);
  }
  if (missing.length === 0) {
    return out;
  }
  const fresh = await params.client.candidateMetadata(missing, params.tenantId);
  for (const [name, entry] of Object.entries(fresh.known ?? {})) {
    assertCategory(entry.category, name);
    metadataCache.set(`${params.tenantId}\0${name}`, {
      known: true,
      category: entry.category,
      expiresAt: now + METADATA_CACHE_TTL_MS,
    });
    out[name] = entry.category;
  }
  for (const name of fresh.unknown ?? []) {
    metadataCache.set(`${params.tenantId}\0${name}`, {
      known: false,
      expiresAt: now + METADATA_CACHE_TTL_MS,
    });
  }
  return out;
}

export type SecretAwareExecResult =
  | { action: "pass" }
  | { action: "reject"; reason: string }
  | {
      action: "handled";
      text: string;
      details: {
        status: "completed";
        accepted: true;
        name: string;
        requestedCount: number;
      };
    }
  | {
      action: "inject";
      env: Record<string, string>;
      redactor: ReturnType<typeof createRuntimeSecretRedactor>;
      names: string[];
    };

export async function evaluateSecretAwareExecCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  client?: PlatformSecretsRuntimeClient;
  allowEnvInjection?: boolean;
}): Promise<SecretAwareExecResult> {
  const candidates = extractSecretReferenceCandidates(params.command);
  const exact = parseExactEchoHeadCommand(params.command);
  if (candidates.length === 0 && !exact) {
    return { action: "pass" };
  }
  const tenantId = resolveRuntimeTenantId(params.env);
  if (!tenantId) {
    if (!exact) {
      return { action: "pass" };
    }
    return { action: "reject", reason: "ROCKIELAB_TENANT_ID is required." };
  }
  const names =
    exact && !candidates.includes(exact.name) ? [...candidates, exact.name].toSorted() : candidates;
  const client = params.client ?? new FetchPlatformSecretsRuntimeClient(params.env);
  const metadata = await getCachedCandidateMetadata({ names, tenantId, client });
  const secretNames = names.filter((name) => metadata[name]);
  if (secretNames.length === 0) {
    return { action: "pass" };
  }
  if (!exact || secretNames.length !== 1 || secretNames[0] !== exact.name) {
    if (params.allowEnvInjection !== true) {
      return {
        action: "reject",
        reason: "Stored secret references are only supported in gateway bash subprocess commands.",
      };
    }
    const envelope = validateResolveEnvelope({
      requested: secretNames,
      envelope: await client.resolve(secretNames, tenantId, "exec.env"),
      metadata,
    });
    return {
      action: "inject",
      env: envelope.resolved,
      redactor: createRuntimeSecretRedactor(envelope.resolved),
      names: secretNames,
    };
  }
  const envelope = validateResolveEnvelope({
    requested: [exact.name],
    envelope: await client.resolve([exact.name], tenantId, "exec.exact.echo_head"),
    metadata,
  });
  const redactor = createRuntimeSecretRedactor(envelope.resolved);
  try {
    return {
      action: "handled",
      text: redactor.redact(`<redacted:${exact.name}>`),
      details: {
        status: "completed",
        accepted: true,
        name: exact.name,
        requestedCount: exact.count,
      },
    };
  } finally {
    redactor.close();
  }
}

export function createRuntimeSecretRedactor(values: Record<string, string>) {
  const entries = Object.entries(values).filter(([, value]) => value.length > 0);
  return {
    redact(text: string): string {
      let out = text;
      for (const [name, value] of entries) {
        out = out.split(value).join(`<redacted:${name}>`);
      }
      return out;
    },
    redactUnknown(value: unknown): unknown {
      if (typeof value === "string") {
        return this.redact(value);
      }
      if (Array.isArray(value)) {
        return value.map((item) => this.redactUnknown(item));
      }
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          out[key] = this.redactUnknown(child);
        }
        return out;
      }
      return value;
    },
    close(): void {
      entries.length = 0;
    },
  };
}

export function resetPlatformSecretMetadataCacheForTests(): void {
  metadataCache.clear();
}
