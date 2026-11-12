import { expect, it, vi } from "vitest";
import { postgresIndexOrderingMigration } from "../infra/database-engine/postgres-index-ordering.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

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
