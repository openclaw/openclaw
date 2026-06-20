import { SESSION_STORE_GATEWAY_ID_ENV, SESSION_STORE_TENANT_ID_ENV } from "./store-async.js";

export const SESSION_STORE_LIVE_POSTGRES_ENV = "OPENCLAW_SESSION_STORE_LIVE_POSTGRES";
export const SESSION_STORE_POSTGRES_URL_ENV = "OPENCLAW_SESSION_STORE_POSTGRES_URL";
export const SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV = "OPENCLAW_SESSION_STORE_POSTGRES_TEST_SCHEMA";
export const SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV =
  "OPENCLAW_SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS";
export const SESSION_STORE_LIVE_POSTGRES_BENCHMARK_ENV =
  "OPENCLAW_SESSION_STORE_LIVE_POSTGRES_BENCHMARK";

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

export type LivePostgresSessionStoreTestConfig =
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
      statementTimeoutMs: number;
      runBenchmark: boolean;
    };

export class LivePostgresSessionStoreTestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivePostgresSessionStoreTestConfigError";
  }
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireEnv(env: Record<string, string | undefined>, key: string, purpose: string): string {
  const value = optionalTrimmed(env[key]);
  if (!value) {
    throw new LivePostgresSessionStoreTestConfigError(`${key} is required ${purpose}`);
  }
  return value;
}

function normalizeStatementTimeoutMs(value: string | undefined): number {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return 5_000;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new LivePostgresSessionStoreTestConfigError(
      `${SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV} must be a positive integer`,
    );
  }
  return Math.floor(parsed);
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
    throw new LivePostgresSessionStoreTestConfigError(
      `${SESSION_STORE_POSTGRES_URL_ENV} must be a valid PostgreSQL URL`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new LivePostgresSessionStoreTestConfigError(
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
      throw new LivePostgresSessionStoreTestConfigError(
        `${SESSION_STORE_POSTGRES_URL_ENV} must not reuse ${key}; use a dedicated non-live OpenClaw session-store database, schema, user, and pool`,
      );
    }
  }
}

function assertTestSchema(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new LivePostgresSessionStoreTestConfigError(
      `${SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV} must be a PostgreSQL-safe identifier`,
    );
  }
  if (!/(^|_)(test|nonlive|integration)(_|$)/i.test(schema)) {
    throw new LivePostgresSessionStoreTestConfigError(
      `${SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV} must include test, nonlive, or integration to avoid production schemas`,
    );
  }
}

export function redactPostgresConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = "REDACTED";
    }
    return url.toString();
  } catch {
    return connectionString.replace(/(:)([^:@/]+)(@)/, "$1REDACTED$3");
  }
}

export function readLivePostgresSessionStoreTestConfig(
  env: Record<string, string | undefined> = process.env,
): LivePostgresSessionStoreTestConfig {
  if (optionalTrimmed(env[SESSION_STORE_LIVE_POSTGRES_ENV]) !== "1") {
    return {
      enabled: false,
      reason: `${SESSION_STORE_LIVE_POSTGRES_ENV}=1 is required for dedicated non-live Postgres integration tests`,
    };
  }

  const connectionString = requireEnv(
    env,
    SESSION_STORE_POSTGRES_URL_ENV,
    "for dedicated non-live Postgres integration tests",
  );
  assertDedicatedConnectionString(connectionString, env);
  const tenantId = requireEnv(env, SESSION_STORE_TENANT_ID_ENV, "for Postgres test isolation");
  const gatewayId = requireEnv(env, SESSION_STORE_GATEWAY_ID_ENV, "for Postgres test isolation");
  const schema = requireEnv(
    env,
    SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV,
    "for dedicated non-live Postgres integration tests",
  );
  assertTestSchema(schema);
  return {
    enabled: true,
    connectionString,
    redactedConnectionString: redactPostgresConnectionString(connectionString),
    tenantId,
    gatewayId,
    schema,
    statementTimeoutMs: normalizeStatementTimeoutMs(
      env[SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV],
    ),
    runBenchmark: optionalTrimmed(env[SESSION_STORE_LIVE_POSTGRES_BENCHMARK_ENV]) === "1",
  };
}
