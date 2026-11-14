import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { postgresIndexOrderingMigration } from "../infra/database-engine/postgres-index-ordering.js";
import { createSqliteFamilyEngines } from "../infra/database-engine/selection-fixture.test-support.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { stateEngineInput } from "./openclaw-state-db-engine-input.js";
import { isStatePostgres, stateEngineSchema } from "./openclaw-state-db-engine.js";

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
