import { describe, expect, it } from "vitest";
import {
  createPostgresSessionStoreRuntimeAdapter,
  PostgresSessionStoreRuntimeConfigError,
  readPostgresSessionStoreRuntimeConfig,
  SESSION_STORE_POSTGRES_APPLICATION_NAME_ENV,
  SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_IDLE_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_POOL_MAX_ENV,
  SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_URL_ENV,
} from "./postgres-runtime-config.js";
import type { PostgresSessionStoreQueryClient } from "./postgres-store-adapter.js";
import {
  SESSION_STORE_BACKEND_ENV,
  SESSION_STORE_GATEWAY_ID_ENV,
  SESSION_STORE_SCHEMA_ENV,
  SESSION_STORE_TENANT_ID_ENV,
} from "./store-async.js";

function postgresEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [SESSION_STORE_BACKEND_ENV]: "postgres",
    [SESSION_STORE_TENANT_ID_ENV]: "type0",
    [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
    [SESSION_STORE_SCHEMA_ENV]: "openclaw_session_store",
    [SESSION_STORE_POSTGRES_URL_ENV]:
      "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
    ...overrides,
  };
}

function fakeClient(): PostgresSessionStoreQueryClient {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("Postgres session-store runtime config", () => {
  it("is disabled unless the core session backend is explicitly postgres", () => {
    expect(readPostgresSessionStoreRuntimeConfig({})).toEqual({
      enabled: false,
      reason:
        "OPENCLAW_SESSION_STORE_BACKEND=postgres is required for Postgres session-store runtime bootstrap",
    });
  });

  it("parses dedicated runtime Postgres config with bounded pool defaults", () => {
    expect(
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({
          [SESSION_STORE_POSTGRES_POOL_MAX_ENV]: "6",
          [SESSION_STORE_POSTGRES_IDLE_TIMEOUT_MS_ENV]: "12000",
          [SESSION_STORE_POSTGRES_CONNECTION_TIMEOUT_MS_ENV]: "3000",
          [SESSION_STORE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV]: "7000",
          [SESSION_STORE_POSTGRES_APPLICATION_NAME_ENV]: "openclaw-plan-b",
        }),
      ),
    ).toEqual({
      enabled: true,
      connectionString:
        "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
      redactedConnectionString:
        "postgres://openclaw_session_store:REDACTED@session-db.local:5432/openclaw_sessions",
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "openclaw_session_store",
      pool: {
        max: 6,
        idleTimeoutMs: 12000,
        connectionTimeoutMs: 3000,
        statementTimeoutMs: 7000,
        applicationName: "openclaw-plan-b",
      },
    });
  });

  it("fails closed instead of using generic or app database URLs", () => {
    expect(() =>
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({
          DATABASE_URL:
            "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
        }),
      ),
    ).toThrow("must not reuse DATABASE_URL");

    expect(() =>
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({
          [SESSION_STORE_POSTGRES_URL_ENV]: undefined,
          DATABASE_URL: "postgres://cms:secret@app-db.local:5432/cms",
        }),
      ),
    ).toThrow(SESSION_STORE_POSTGRES_URL_ENV);

    expect(() =>
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({
          PAYLOAD_DATABASE_URL:
            "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
        }),
      ),
    ).toThrow("must not reuse PAYLOAD_DATABASE_URL");
  });

  it("rejects unsafe runtime schemas and unbounded pool settings", () => {
    expect(() =>
      readPostgresSessionStoreRuntimeConfig(postgresEnv({ [SESSION_STORE_SCHEMA_ENV]: "public" })),
    ).toThrow("must not be public");

    expect(() =>
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({ [SESSION_STORE_SCHEMA_ENV]: "openclaw-session-store" }),
      ),
    ).toThrow("PostgreSQL-safe identifier");

    expect(() =>
      readPostgresSessionStoreRuntimeConfig(
        postgresEnv({ [SESSION_STORE_POSTGRES_POOL_MAX_ENV]: "50" }),
      ),
    ).toThrow("must be <= 20");
  });

  it("creates an adapter only through an explicit caller-provided client factory", async () => {
    const seenConfigs: unknown[] = [];
    const adapter = await createPostgresSessionStoreRuntimeAdapter({
      env: postgresEnv(),
      createClient(config) {
        seenConfigs.push(config);
        return fakeClient();
      },
    });

    expect(adapter.kind).toBe("postgres");
    expect(seenConfigs).toHaveLength(1);
    expect(seenConfigs[0]).toMatchObject({
      enabled: true,
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "openclaw_session_store",
      pool: { max: 4, statementTimeoutMs: 5000 },
    });

    await expect(
      createPostgresSessionStoreRuntimeAdapter({
        env: {},
        createClient: fakeClient,
      }),
    ).rejects.toBeInstanceOf(PostgresSessionStoreRuntimeConfigError);
  });
});
