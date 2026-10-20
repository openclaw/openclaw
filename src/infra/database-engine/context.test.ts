import { afterEach, expect, it } from "vitest";
import {
  withDatabaseEngineSelection,
  getDatabaseEngineInput,
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";

const sqliteEngines: DatabaseEngineSelection["effectiveEngines"] = {
  state: "sqlite",
  agent: "sqlite",
  workboard: "sqlite",
  logbook: "sqlite",
  "team-reports": "sqlite",
  quarantine: "sqlite",
  "managed-update": "sqlite",
  "package-activation": "sqlite",
};
const postgres = { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" };

afterEach(resetDatabaseEngineSelectionForTest);

it("publishes one immutable mixed selection to existing and new async callers", async () => {
  const readLater = async () => {
    await Promise.resolve();
    return getDatabaseEngineSelection();
  };
  const pending = readLater();
  const effectiveEngines = { ...sqliteEngines, state: "postgres" as const };
  installDatabaseEngineSelection({ effectiveEngines, postgres });
  const selected = getDatabaseEngineSelection();
  expect(await pending).toBe(selected);
  expect(await readLater()).toBe(selected);
  expect(getDatabaseEngineInput("state")).toEqual(postgres);
  expect(getDatabaseEngineInput("agent")).toBeUndefined();
  expect(getDatabaseEngineInput("workboard")).toBeUndefined();
  expect(Object.isFrozen(selected?.effectiveEngines)).toBe(true);
  expect(Object.isFrozen(selected?.postgres)).toBe(true);
  expect(Object.isFrozen(selected)).toBe(true);
  installDatabaseEngineSelection({
    effectiveEngines: { ...effectiveEngines },
    postgres: { ...postgres },
  });
  expect(getDatabaseEngineSelection()).toBe(selected);
});

it("distinguishes not installed from installed SQLite and refuses a family change", () => {
  expect(getDatabaseEngineSelection()).toBeUndefined();
  installDatabaseEngineSelection({ effectiveEngines: sqliteEngines });
  const selected = getDatabaseEngineSelection();
  expect(selected).toEqual({ effectiveEngines: sqliteEngines });
  expect(getDatabaseEngineInput("state")).toBeUndefined();
  installDatabaseEngineSelection({ effectiveEngines: { ...sqliteEngines } });
  expect(() =>
    installDatabaseEngineSelection({
      effectiveEngines: { ...sqliteEngines, workboard: "postgres" },
      postgres,
    }),
  ).toThrow(/conflicts with the installed process selection.*restart/);
  expect(getDatabaseEngineSelection()).toBe(selected);
});

it.each([
  { ...postgres, connection: "postgresql://localhost/other" },
  { ...postgres, schemaPrefix: "other" },
])("refuses to replace the PostgreSQL connection or namespace: %j", (nextPostgres) => {
  const effectiveEngines = { ...sqliteEngines, state: "postgres" as const };
  installDatabaseEngineSelection({ effectiveEngines, postgres });
  const selected = getDatabaseEngineSelection();
  expect(() =>
    installDatabaseEngineSelection({ effectiveEngines, postgres: nextPostgres }),
  ).toThrow("conflicts with the installed process selection");
  expect(getDatabaseEngineSelection()).toBe(selected);
});

it("refuses swapping PostgreSQL families while keeping the same DSN", () => {
  installDatabaseEngineSelection({
    effectiveEngines: { ...sqliteEngines, state: "postgres" },
    postgres,
  });
  expect(() =>
    installDatabaseEngineSelection({
      effectiveEngines: { ...sqliteEngines, workboard: "postgres" },
      postgres,
    }),
  ).toThrow(/conflicts with the installed process selection.*restart/);
});

it("scopes the full family map across awaits without replacing the boot selection", async () => {
  const boot = { effectiveEngines: { ...sqliteEngines, state: "postgres" as const }, postgres };
  installDatabaseEngineSelection(boot);
  await withDatabaseEngineSelection(
    { effectiveEngines: { ...sqliteEngines, agent: "postgres" }, postgres },
    async () => {
      await Promise.resolve();
      expect(getDatabaseEngineInput("state")).toBeUndefined();
      expect(getDatabaseEngineInput("agent")).toEqual(postgres);
    },
  );
  expect(getDatabaseEngineSelection()).toBe(boot);
  expect(getDatabaseEngineInput("state")).toEqual(postgres);
  expect(getDatabaseEngineInput("agent")).toBeUndefined();
});
