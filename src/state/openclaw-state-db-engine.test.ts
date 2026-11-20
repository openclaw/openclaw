import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import * as physicalFacts from "../infra/database-engine/physical-facts.js";
import { postgresIndexOrderingMigration } from "../infra/database-engine/postgres-index-ordering.js";
import { createSqliteFamilyEngines } from "../infra/database-engine/selection-fixture.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { PostgresSqlConnection } from "../infra/sql-connection.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { stateEngineInput } from "./openclaw-state-db-engine-input.js";
import {
  ensureStatePostgresFragment,
  isStatePostgres,
  stateEngineSchema,
} from "./openclaw-state-db-engine.js";

vi.mock("../infra/database-engine/postgres-index-ordering.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/database-engine/postgres-index-ordering.js")>();
  return {
    ...actual,
    postgresIndexOrderingMigration: vi.fn(actual.postgresIndexOrderingMigration),
  };
});

it("does not derive PostgreSQL migrations for SQLite startup and retains the requested plan", () => {
  expect(vi.mocked(postgresIndexOrderingMigration).mock.calls.length).toBe(0);
  for (const [index, schema] of [stateEngineSchema, agentEngineSchema].entries()) {
    const migrations = schema.postgresMigrations;
    expect(migrations?.at(-1)?.version).toBe(schema.version);
    expect(postgresIndexOrderingMigration).toHaveBeenCalledTimes((index + 1) * 2);
    expect(schema.postgresMigrations).toBe(migrations);
    expect(postgresIndexOrderingMigration).toHaveBeenCalledTimes((index + 1) * 2);
  }
});

it("preserves explicit backend selection and the test-only state connection fallback", () => {
  const key = "openclaw.test.state.connection";
  const previousConnection = getEnvironmentData(key);
  const previousSelection = getDatabaseEngineSelection();
  resetDatabaseEngineSelectionForTest();
  try {
    vi.stubEnv("NODE_ENV", "test");
    setEnvironmentData(key, "postgres://fixture.invalid/fallback");
    expect(stateEngineInput()).toEqual({
      connection: "postgres://fixture.invalid/fallback",
      schemaPrefix: "openclaw_test",
    });
    expect(isStatePostgres()).toBe(true);
    withDatabaseEngineSelection({ effectiveEngines: createSqliteFamilyEngines() }, () => {
      expect(stateEngineInput()).toBeUndefined();
      expect(isStatePostgres()).toBe(false);
    });
    const postgres = {
      connection: "postgres://fixture.invalid/selected",
      schemaPrefix: "selected",
    };
    withDatabaseEngineSelection(
      {
        effectiveEngines: createSqliteFamilyEngines({ state: "postgres" }),
        postgres,
      },
      () => {
        expect(stateEngineInput()).toBe(postgres);
        expect(isStatePostgres()).toBe(true);
      },
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(stateEngineInput()).toBeUndefined();
    vi.stubEnv("NODE_ENV", "test");
    setEnvironmentData(key, 42);
    expect(stateEngineInput()).toBeUndefined();
  } finally {
    setEnvironmentData(key, previousConnection);
    resetDatabaseEngineSelectionForTest();
    if (previousSelection) {
      installDatabaseEngineSelection(previousSelection);
    }
    vi.unstubAllEnvs();
  }
});

it.each([
  { version: 37, disk: false, recovery: false },
  { version: 40, disk: true, recovery: false },
  { version: 41, disk: true, recovery: true },
])(
  "creates repository fragments with only version $version columns",
  ({ version, disk, recovery }) => {
    using anchor = openNodeSqliteDatabase(":memory:");
    const captured = new Error("captured fragment DDL before PostgreSQL execution");
    let fragmentSql = "";
    const unused = () => {
      throw new Error("Unexpected database I/O before fragment DDL");
    };
    const db: PostgresSqlConnection = {
      anchor,
      isOpen: true,
      isTransaction: false,
      mutationRevision: 0,
      advisoryLockKey: 0n,
      prepare: unused,
      query: unused,
      close: unused,
      releaseIdleTransport: unused,
      runTransaction: unused,
      exec(sql) {
        // Conformance owns catalog admission; this proof stops at the emitted DDL.
        fragmentSql = sql;
        throw captured;
      },
    };
    Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
    const facts = vi.spyOn(physicalFacts, "getPostgresPhysicalFacts").mockReturnValue({
      engine: "postgres",
      admissionId: "fragment-test",
      store: "state",
      namespace: "fragment_test",
      storeId: "fragment-test",
      version,
      capabilities: { serverMajor: 17, serverEncoding: "UTF8", clientEncoding: "UTF8" },
      catalog: [],
    });
    try {
      expect(() =>
        withSqlitePostCommitPublications(db, () =>
          ensureStatePostgresFragment(db, "session_repository_workspaces"),
        ),
      ).toThrow(captured);
      expect(fragmentSql).toContain('CREATE TABLE "session_repository_workspaces"');
      expect(fragmentSql.includes('"disk_authority_json"')).toBe(disk);
      expect(fragmentSql.includes('"recovery_json"')).toBe(recovery);
    } finally {
      facts.mockRestore();
    }
  },
);
