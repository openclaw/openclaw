import { describe, expect, it } from "vitest";
import {
  readLivePostgresSessionStoreTestConfig,
  redactPostgresConnectionString,
  SESSION_STORE_LIVE_POSTGRES_ENV,
  SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV,
  SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV,
  SESSION_STORE_POSTGRES_URL_ENV,
} from "./postgres-live-integration-gate.js";
import { SESSION_STORE_GATEWAY_ID_ENV, SESSION_STORE_TENANT_ID_ENV } from "./store-async.js";

describe("Postgres live integration gate", () => {
  it("is disabled by default without inspecting generic DATABASE_URL values", () => {
    expect(
      readLivePostgresSessionStoreTestConfig({
        DATABASE_URL: "postgres://cms-user:secret@example.invalid/payload",
      }),
    ).toEqual({
      enabled: false,
      reason: `${SESSION_STORE_LIVE_POSTGRES_ENV}=1 is required for dedicated non-live Postgres integration tests`,
    });
  });

  it("requires a dedicated OpenClaw session-store URL and identity scope when enabled", () => {
    expect(() =>
      readLivePostgresSessionStoreTestConfig({ [SESSION_STORE_LIVE_POSTGRES_ENV]: "1" }),
    ).toThrow(SESSION_STORE_POSTGRES_URL_ENV);

    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: "postgres://openclaw:secret@example.invalid/test",
      }),
    ).toThrow(SESSION_STORE_TENANT_ID_ENV);

    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: "postgres://openclaw:secret@example.invalid/test",
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
      }),
    ).toThrow(SESSION_STORE_GATEWAY_ID_ENV);
  });

  it("fails closed if the non-live Postgres URL reuses generic or app database envs", () => {
    const connectionString = "postgres://openclaw:secret@example.invalid/session_store_test";
    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: connectionString,
        DATABASE_URL: connectionString,
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
        [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
        [SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV]: "openclaw_session_test",
      }),
    ).toThrow("must not reuse DATABASE_URL");

    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: connectionString,
        PAYLOAD_DATABASE_URL: connectionString,
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
        [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
        [SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV]: "openclaw_session_test",
      }),
    ).toThrow("must not reuse PAYLOAD_DATABASE_URL");
  });

  it("requires a PostgreSQL URL for non-live integration tests", () => {
    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: "https://example.invalid/session_store_test",
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
        [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
        [SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV]: "openclaw_session_test",
      }),
    ).toThrow("must use postgres:// or postgresql://");
  });

  it("requires an explicitly test/nonlive/integration schema", () => {
    expect(() =>
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: "postgres://openclaw:secret@example.invalid/test",
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
        [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
        [SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV]: "openclaw",
      }),
    ).toThrow("must include test, nonlive, or integration");
  });

  it("parses approved non-live settings and redacts credentials for receipts", () => {
    expect(
      readLivePostgresSessionStoreTestConfig({
        [SESSION_STORE_LIVE_POSTGRES_ENV]: "1",
        [SESSION_STORE_POSTGRES_URL_ENV]: "postgres://openclaw:secret@example.invalid/test",
        [SESSION_STORE_TENANT_ID_ENV]: "type0",
        [SESSION_STORE_GATEWAY_ID_ENV]: "type0-producer",
        [SESSION_STORE_POSTGRES_TEST_SCHEMA_ENV]: "openclaw_session_test",
        [SESSION_STORE_LIVE_POSTGRES_STATEMENT_TIMEOUT_MS_ENV]: "2500",
      }),
    ).toEqual({
      enabled: true,
      connectionString: "postgres://openclaw:secret@example.invalid/test",
      redactedConnectionString: "postgres://openclaw:REDACTED@example.invalid/test",
      tenantId: "type0",
      gatewayId: "type0-producer",
      schema: "openclaw_session_test",
      statementTimeoutMs: 2500,
      runBenchmark: false,
    });

    expect(redactPostgresConnectionString("postgres://user:password@localhost:5432/db")).toBe(
      "postgres://user:REDACTED@localhost:5432/db",
    );
  });
});
