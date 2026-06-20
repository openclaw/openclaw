import {
  createPostgresSessionStoreAdapter,
  type PostgresSessionStoreQueryClient,
} from "./postgres-store-adapter.js";
import type { SessionStoreAdapter } from "./storage-adapter.js";
import {
  readSessionStoreBackendConfig,
  SESSION_STORE_BACKEND_ENV,
  SESSION_STORE_SCHEMA_ENV,
} from "./store-async.js";

export const SESSION_STORE_POSTGRES_URL_ENV = "OPENCLAW_SESSION_STORE_POSTGRES_URL";
export const SESSION_STORE_POSTGRES_POOL_MAX_ENV = "OPENCLAW_SESSION_STORE_POSTGRES_POOL_MAX";
export const SESSION_STORE_POSTGRES_IDLE_TIMEOUT_MS_ENV =
  "OPENCLAW_SESSION_STORE_POSTGRES_IDLE_TIMEOUT_MS";
export const SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV =
  "OPENCLAW_SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS";
export const SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV =
  "OPENCLAW_SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS";
export const SESSION_STORE_POSTGRES_APPLICATION_NAME_ENV =
  "OPENCLAW_SESSION_STORE_POSTGRES_APPLICATION_NAME";

export type PostgresSessionStoreRuntimePoolConfig = {
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
};

export type PostgresSessionStoreRuntimeConfig =
  | {
      enabled: false;
      reason: string;
    }
  | {
      enabled: true;
      connectionString: string;
      redactedConnectionString: string;
      tenantId: string;
      gatewayId: string;
      schema: string;
      pool: PostgresSessionStoreRuntimePoolConfig;
    };

export type EnabledPostgresSessionStoreRuntimeConfig = Extract<
  PostgresSessionStoreRuntimeConfig,
  { enabled: true }
>;

export type PostgresSessionStoreRuntimeClientFactory = (
  config: EnabledPostgresSessionStoreRuntimeConfig,
) => PostgresSessionStoreQueryClient | Promise<PostgresSessionStoreQueryClient>;

export class PostgresSessionStoreRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresSessionStoreRuntimeConfigError";
  }
}

const GENERIC_OR_APP_DB_URL_ENVS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "PAYLOAD_DATABASE_URL",
  "PAYLOAD_DATABASE_URI",
  "CMS_DATABASE_URL",
  "SUPABASE_DB_URL",
  "SUPABASE_DATABASE_URL",
] as const;

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = optionalTrimmed(env[key]);
  if (!value) {
    throw new PostgresSessionStoreRuntimeConfigError(`${key} is required`);
  }
  return value;
}

function normalizePositiveIntegerEnv(params: {
  env: Record<string, string | undefined>;
  key: string;
  defaultValue: number;
  maxValue?: number;
}): number {
  const raw = optionalTrimmed(params.env[params.key]);
  if (!raw) {
    return params.defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || Math.floor(parsed) !== parsed) {
    throw new PostgresSessionStoreRuntimeConfigError(`${params.key} must be a positive integer`);
  }
  if (params.maxValue !== undefined && parsed > params.maxValue) {
    throw new PostgresSessionStoreRuntimeConfigError(`${params.key} must be <= ${params.maxValue}`);
  }
  return parsed;
}

function normalizeUrlForCompare(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function assertPostgresConnectionString(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PostgresSessionStoreRuntimeConfigError(
      `${SESSION_STORE_POSTGRES_URL_ENV} must be a valid PostgreSQL URL`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PostgresSessionStoreRuntimeConfigError(
      `${SESSION_STORE_POSTGRES_URL_ENV} must use postgres:// or postgresql://`,
    );
  }
}

function assertDedicatedConnectionString(
  connectionString: string,
  env: Record<string, string | undefined>,
): void {
  assertPostgresConnectionString(connectionString);
  const normalizedSessionStoreUrl = normalizeUrlForCompare(connectionString);
  for (const key of GENERIC_OR_APP_DB_URL_ENVS) {
    const candidate = optionalTrimmed(env[key]);
    if (!candidate) {
      continue;
    }
    if (normalizeUrlForCompare(candidate) === normalizedSessionStoreUrl) {
      throw new PostgresSessionStoreRuntimeConfigError(
        `${SESSION_STORE_POSTGRES_URL_ENV} must not reuse ${key}; use a dedicated OpenClaw session-store database, schema, user, and pool`,
      );
    }
  }
}

function assertRuntimeSchema(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new PostgresSessionStoreRuntimeConfigError(
      `${SESSION_STORE_SCHEMA_ENV} must be a PostgreSQL-safe identifier`,
    );
  }
  if (schema.toLowerCase() === "public") {
    throw new PostgresSessionStoreRuntimeConfigError(
      `${SESSION_STORE_SCHEMA_ENV} must not be public; use a dedicated OpenClaw session-store schema`,
    );
  }
}

export function redactPostgresRuntimeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.username) {
      url.username = "openclaw_session_store";
    }
    if (url.password) {
      url.password = "REDACTED";
    }
    return url.toString();
  } catch {
    return connectionString.replace(/(:)([^:@/]+)(@)/, "$1REDACTED$3");
  }
}

function defaultApplicationName(tenantId: string, gatewayId: string): string {
  return `openclaw-session-store:${tenantId}:${gatewayId}`.slice(0, 128);
}

export function readPostgresSessionStoreRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): PostgresSessionStoreRuntimeConfig {
  const backend = readSessionStoreBackendConfig(env);
  if (backend.backend !== "postgres") {
    return {
      enabled: false,
      reason: `${SESSION_STORE_BACKEND_ENV}=postgres is required for Postgres session-store runtime bootstrap`,
    };
  }
  const connectionString = requireEnv(env, SESSION_STORE_POSTGRES_URL_ENV);
  assertDedicatedConnectionString(connectionString, env);
  const schema = requireEnv(env, SESSION_STORE_SCHEMA_ENV);
  assertRuntimeSchema(schema);
  const applicationName =
    optionalTrimmed(env[SESSION_STORE_POSTGRES_APPLICATION_NAME_ENV]) ??
    defaultApplicationName(backend.tenantId, backend.gatewayId);
  return {
    enabled: true,
    connectionString,
    redactedConnectionString: redactPostgresRuntimeConnectionString(connectionString),
    tenantId: backend.tenantId,
    gatewayId: backend.gatewayId,
    schema,
    pool: {
      max: normalizePositiveIntegerEnv({
        env,
        key: SESSION_STORE_POSTGRES_POOL_MAX_ENV,
        defaultValue: 4,
        maxValue: 20,
      }),
      idleTimeoutMs: normalizePositiveIntegerEnv({
        env,
        key: SESSION_STORE_POSTGRES_IDLE_TIMEOUT_MS_ENV,
        defaultValue: 10_000,
      }),
      connectionTimeoutMs: normalizePositiveIntegerEnv({
        env,
        key: SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV,
        defaultValue: 2_000,
      }),
      statementTimeoutMs: normalizePositiveIntegerEnv({
        env,
        key: SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV,
        defaultValue: 5_000,
      }),
      applicationName,
    },
  };
}

export async function createPostgresSessionStoreRuntimeAdapter(options: {
  env?: Record<string, string | undefined>;
  createClient: PostgresSessionStoreRuntimeClientFactory;
}): Promise<SessionStoreAdapter> {
  const config = readPostgresSessionStoreRuntimeConfig(options.env);
  if (!config.enabled) {
    throw new PostgresSessionStoreRuntimeConfigError(config.reason);
  }
  const client = await options.createClient(config);
  return createPostgresSessionStoreAdapter(client, {
    tenantId: config.tenantId,
    gatewayId: config.gatewayId,
    schema: config.schema,
  });
}
