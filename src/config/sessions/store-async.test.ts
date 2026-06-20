import { afterEach, describe, expect, it } from "vitest";
import type { PostgresSessionStoreQueryClient } from "./postgres-store-adapter.js";
import type { SessionStoreAdapter, SessionStoreRecord } from "./storage-adapter.js";
import {
  clearSessionStoreRuntimeAdapterFactory,
  configureSessionStoreRuntimeAdapterFactory,
  loadSessionStoreAsync,
  readSessionStoreBackendConfig,
  resolveSessionStoreAdapter,
  SESSION_STORE_BACKEND_ENV,
  SESSION_STORE_GATEWAY_ID_ENV,
  SESSION_STORE_SCHEMA_ENV,
  SESSION_STORE_TENANT_ID_ENV,
  SessionStoreBackendConfigError,
} from "./store-async.js";

function fakePostgresClient(): PostgresSessionStoreQueryClient {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
}

function memoryAdapter(kind: "json" | "postgres", store: SessionStoreRecord): SessionStoreAdapter {
  return {
    kind,
    async loadStore() {
      return structuredClone(store) as SessionStoreRecord;
    },
    async readEntry(_storePath, sessionKey) {
      return store[sessionKey];
    },
    async listEntries() {
      return {
        entries: Object.entries(store),
        totalCount: Object.keys(store).length,
        hasMore: false,
      };
    },
    async saveStore(_storePath, nextStore) {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
      Object.assign(store, structuredClone(nextStore) as SessionStoreRecord);
    },
    async updateStore<T>(
      _storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
    ) {
      return await mutator(store);
    },
  };
}

const originalEnv: Record<string, string | undefined> = {};
for (const key of [
  SESSION_STORE_BACKEND_ENV,
  SESSION_STORE_TENANT_ID_ENV,
  SESSION_STORE_GATEWAY_ID_ENV,
  SESSION_STORE_SCHEMA_ENV,
]) {
  originalEnv[key] = process.env[key];
}

afterEach(() => {
  clearSessionStoreRuntimeAdapterFactory();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("session store backend selector", () => {
  it("defaults to the JSON adapter unless a backend is explicitly configured", () => {
    expect(readSessionStoreBackendConfig({})).toEqual({ backend: "json" });
    expect(resolveSessionStoreAdapter({ env: {} }).kind).toBe("json");
  });

  it("parses explicit Postgres settings without creating a DB client implicitly", () => {
    const env = {
      [SESSION_STORE_BACKEND_ENV]: "postgresql",
      [SESSION_STORE_TENANT_ID_ENV]: "type0",
      [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
      [SESSION_STORE_SCHEMA_ENV]: "type0_sessions",
    };

    expect(readSessionStoreBackendConfig(env)).toEqual({
      backend: "postgres",
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "type0_sessions",
    });
    expect(() => resolveSessionStoreAdapter({ env })).toThrow(SessionStoreBackendConfigError);
    expect(() => resolveSessionStoreAdapter({ env })).toThrow("dedicated OpenClaw session-store");
  });

  it("creates a Postgres adapter only with an explicitly injected query client", () => {
    expect(
      resolveSessionStoreAdapter({
        env: {
          [SESSION_STORE_BACKEND_ENV]: "postgres",
          [SESSION_STORE_TENANT_ID_ENV]: "type0",
          [SESSION_STORE_GATEWAY_ID_ENV]: "type0-audit",
        },
        postgresClient: fakePostgresClient(),
      }).kind,
    ).toBe("postgres");
  });

  it("uses an explicitly registered runtime adapter for async store calls", async () => {
    process.env[SESSION_STORE_BACKEND_ENV] = "postgres";
    process.env[SESSION_STORE_TENANT_ID_ENV] = "type0";
    process.env[SESSION_STORE_GATEWAY_ID_ENV] = "type0-producer";
    const store = {
      "agent:main:main": { sessionId: "sess-main", updatedAt: 1 },
    };
    const restore = configureSessionStoreRuntimeAdapterFactory((config) => {
      expect(config).toEqual({
        backend: "postgres",
        tenantId: "type0",
        gatewayId: "type0-producer",
      });
      return memoryAdapter("postgres", store);
    });

    await expect(loadSessionStoreAsync("/state/sessions.json")).resolves.toEqual(store);
    restore();
    expect(() => resolveSessionStoreAdapter()).toThrow("dedicated OpenClaw session-store");
  });

  it("fails closed when a registered runtime adapter kind does not match the configured backend", () => {
    const restore = configureSessionStoreRuntimeAdapterFactory(() => memoryAdapter("json", {}));
    expect(() =>
      resolveSessionStoreAdapter({
        env: {
          [SESSION_STORE_BACKEND_ENV]: "postgres",
          [SESSION_STORE_TENANT_ID_ENV]: "type0",
          [SESSION_STORE_GATEWAY_ID_ENV]: "type0-audit",
        },
      }),
    ).toThrow('Runtime session store adapter kind "json" does not match configured backend');
    restore();

    configureSessionStoreRuntimeAdapterFactory(() => memoryAdapter("postgres", {}));
    expect(() => resolveSessionStoreAdapter({ env: {} })).toThrow(
      'Runtime session store adapter kind "postgres" does not match configured backend "json"',
    );
  });

  it("fails closed for unsupported backends and missing Postgres identity scope", () => {
    expect(() => readSessionStoreBackendConfig({ [SESSION_STORE_BACKEND_ENV]: "sqlite" })).toThrow(
      "Unsupported session store backend",
    );
    expect(() =>
      readSessionStoreBackendConfig({ [SESSION_STORE_BACKEND_ENV]: "postgres" }),
    ).toThrow(SESSION_STORE_TENANT_ID_ENV);
    expect(() =>
      readSessionStoreBackendConfig({
        [SESSION_STORE_BACKEND_ENV]: "postgres",
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
      }),
    ).toThrow(SESSION_STORE_GATEWAY_ID_ENV);
  });
});
