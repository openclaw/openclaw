import { expect, it, vi } from "vitest";
import { postgresIndexOrderingMigration } from "../infra/database-engine/postgres-index-ordering.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { agentEngineSchema, openAgentEngineStore } from "./openclaw-agent-db-engine.js";

vi.mock("../infra/database-engine/postgres-index-ordering.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/database-engine/postgres-index-ordering.js")>();
  return {
    ...actual,
    postgresIndexOrderingMigration: vi.fn(actual.postgresIndexOrderingMigration),
  };
});

it("opens SQLite without deriving PostgreSQL history and retains the requested migration plan", () => {
  using db = openNodeSqliteDatabase(":memory:");
  expect(openAgentEngineStore(db, "main", ":memory:")).toBe(db);
  expect(postgresIndexOrderingMigration).not.toHaveBeenCalled();
  const migrations = agentEngineSchema.postgresMigrations;
  expect(migrations?.at(-1)?.version).toBe(agentEngineSchema.version);
  expect(postgresIndexOrderingMigration).toHaveBeenCalledTimes(2);
  expect(agentEngineSchema.postgresMigrations).toBe(migrations);
  expect(postgresIndexOrderingMigration).toHaveBeenCalledTimes(2);
});
