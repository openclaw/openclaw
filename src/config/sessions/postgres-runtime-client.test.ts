import { afterEach, describe, expect, it } from "vitest";
import {
  createLazyPostgresSessionStoreQueryClient,
  getPostgresSessionStoreRuntimeMetricsSummary,
  installPostgresSessionStoreRuntimeAdapterFactory,
  type PgModuleLike,
  type PgPoolLike,
} from "./postgres-runtime-client.js";
import {
  PostgresSessionStoreRuntimeConfigError,
  readPostgresSessionStoreRuntimeConfig,
} from "./postgres-runtime-config.js";
import { SESSION_STORE_POSTGRES_URL_ENV } from "./postgres-runtime-config.js";
import {
  clearSessionStoreRuntimeAdapterFactory,
  resolveSessionStoreAdapter,
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

class FakePool implements PgPoolLike {
  ended = false;
  queries: Array<{ sql: string; values?: readonly unknown[] }> = [];

  constructor(readonly options: Record<string, unknown>) {}

  async query(sql: string, values?: readonly unknown[]) {
    this.queries.push({ sql, ...(values ? { values } : {}) });
    if (sql.startsWith("select $1")) {
      return { rows: [{ ok: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async end() {
    this.ended = true;
  }
}

function fakePgModule(pools: FakePool[]): PgModuleLike {
  return {
    Pool: class extends FakePool {
      constructor(options: Record<string, unknown>) {
        super(options);
        pools.push(this);
      }
    },
  };
}

afterEach(() => {
  clearSessionStoreRuntimeAdapterFactory();
});

describe("Postgres session-store runtime client", () => {
  it("lazily creates a bounded pg pool from dedicated session-store config", async () => {
    const config = readPostgresSessionStoreRuntimeConfig(postgresEnv());
    expect(config.enabled).toBe(true);
    if (!config.enabled) {
      throw new Error("expected enabled postgres config");
    }
    const pools: FakePool[] = [];
    const client = createLazyPostgresSessionStoreQueryClient(config, {
      loadPg: () => fakePgModule(pools),
    });

    expect(client.getPoolForTest()).toBeUndefined();
    await expect(client.query("select $1::int as value", [1])).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1,
    });
    expect(pools).toHaveLength(1);
    expect(pools[0]?.options).toMatchObject({
      connectionString:
        "postgres://openclaw_session_store:secret@session-db.local:5432/openclaw_sessions",
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      application_name: "openclaw-session-store:type0:type0-producer",
    });

    await client.query("select 2");
    expect(pools).toHaveLength(1);
    await client.end();
    expect(pools[0]?.ended).toBe(true);
  });

  it("installs a runtime adapter factory only when postgres backend is explicitly enabled", async () => {
    expect(getPostgresSessionStoreRuntimeMetricsSummary()).toBeUndefined();

    const disabled = await installPostgresSessionStoreRuntimeAdapterFactory({ env: {} });
    expect(disabled.enabled).toBe(false);
    await disabled.cleanup();
    expect(getPostgresSessionStoreRuntimeMetricsSummary()).toBeUndefined();
    expect(resolveSessionStoreAdapter({ env: {} }).kind).toBe("json");

    const pools: FakePool[] = [];
    const installed = await installPostgresSessionStoreRuntimeAdapterFactory({
      env: postgresEnv(),
      loadPg: () => fakePgModule(pools),
    });
    expect(installed).toMatchObject({
      enabled: true,
      redactedConnectionString:
        "postgres://openclaw_session_store:REDACTED@session-db.local:5432/openclaw_sessions",
    });
    expect(getPostgresSessionStoreRuntimeMetricsSummary()).toEqual({
      backend: "postgres",
      totalOperations: 0,
      failedOperations: 0,
      recentOperations: [],
    });

    const adapter = resolveSessionStoreAdapter({ env: postgresEnv() });
    expect(adapter.kind).toBe("postgres");
    await expect(adapter.listEntries("/state/sessions.json", { limit: 1 })).resolves.toMatchObject({
      totalCount: 0,
      hasMore: false,
    });
    expect(installed.metrics).toEqual([
      expect.objectContaining({
        backend: "postgres",
        operation: "listEntries",
        storePath: "/state/sessions.json",
        ok: true,
        entryCount: 0,
        totalCount: 0,
        hasMore: false,
      }),
    ]);
    expect(getPostgresSessionStoreRuntimeMetricsSummary({ limit: 1 })).toEqual({
      backend: "postgres",
      totalOperations: 1,
      failedOperations: 0,
      recentOperations: [
        expect.objectContaining({
          operation: "listEntries",
          ok: true,
          entryCount: 0,
          totalCount: 0,
          hasMore: false,
        }),
      ],
    });
    expect(getPostgresSessionStoreRuntimeMetricsSummary({ limit: 0 })).toEqual({
      backend: "postgres",
      totalOperations: 1,
      failedOperations: 0,
      recentOperations: [],
    });
    expect(pools).toHaveLength(1);

    expect(() =>
      resolveSessionStoreAdapter({
        env: postgresEnv({ [SESSION_STORE_GATEWAY_ID_ENV]: "type0-other" }),
      }),
    ).toThrow("different tenant/gateway/schema scope");

    await installed.cleanup();
    expect(pools[0]?.ended).toBe(true);
    expect(getPostgresSessionStoreRuntimeMetricsSummary()).toBeUndefined();
    expect(() => resolveSessionStoreAdapter({ env: postgresEnv() })).toThrow(
      "requires an injected dedicated OpenClaw session-store query client",
    );
  });

  it("records failed runtime adapter operations before rethrowing", async () => {
    class FailingPool extends FakePool {
      override async query(
        sql: string,
        values?: readonly unknown[],
      ): Promise<{ rows: []; rowCount: 0 }> {
        this.queries.push({ sql, ...(values ? { values } : {}) });
        throw new Error("database unavailable");
      }
    }
    const pools: FailingPool[] = [];
    const installed = await installPostgresSessionStoreRuntimeAdapterFactory({
      env: postgresEnv(),
      loadPg: () => ({
        Pool: class extends FailingPool {
          constructor(options: Record<string, unknown>) {
            super(options);
            pools.push(this);
          }
        },
      }),
    });

    const adapter = resolveSessionStoreAdapter({ env: postgresEnv() });
    await expect(adapter.readEntry("/state/sessions.json", "main")).rejects.toThrow(
      "database unavailable",
    );
    expect(getPostgresSessionStoreRuntimeMetricsSummary()).toEqual({
      backend: "postgres",
      totalOperations: 1,
      failedOperations: 1,
      recentOperations: [
        expect.objectContaining({
          operation: "readEntry",
          ok: false,
          errorName: "Error",
          errorMessage: "database unavailable",
        }),
      ],
    });
    expect(installed.metrics).toEqual([
      expect.objectContaining({
        backend: "postgres",
        operation: "readEntry",
        storePath: "/state/sessions.json",
        ok: false,
        errorName: "Error",
        errorMessage: "database unavailable",
      }),
    ]);
    expect(pools).toHaveLength(1);

    await installed.cleanup();
  });

  it("reports a clear error when pg is unavailable", async () => {
    const config = readPostgresSessionStoreRuntimeConfig(postgresEnv());
    expect(config.enabled).toBe(true);
    if (!config.enabled) {
      throw new Error("expected enabled postgres config");
    }
    const client = createLazyPostgresSessionStoreQueryClient(config, {
      loadPg() {
        throw new Error("module not found");
      },
    });

    await expect(client.query("select 1")).rejects.toBeInstanceOf(
      PostgresSessionStoreRuntimeConfigError,
    );
    await expect(client.query("select 1")).rejects.toThrow('requires optional package "pg"');
  });
});
