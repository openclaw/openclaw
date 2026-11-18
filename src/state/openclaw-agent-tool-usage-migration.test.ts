import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { AGENT_ACTIVE_EVENT_FACTS_SQL } from "./openclaw-agent-active-event-facts-schema.js";
import { migrateAgentColdNavigationInTransaction } from "./openclaw-agent-cold-navigation-schema.js";
import { AGENT_CREATION_OPERATIONS_SQL } from "./openclaw-agent-creation-operations-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV38Schema,
} from "./schema-migration.test-support.js";

function seed(database: DatabaseSync) {
  seedAgentV38Schema(database);
  runSqliteImmediateTransactionSync(database, () =>
    migrateAgentColdNavigationInTransaction(database),
  );
  database.exec(`${AGENT_CREATION_OPERATIONS_SQL}\n${AGENT_ACTIVE_EVENT_FACTS_SQL}
    PRAGMA user_version=41; UPDATE schema_meta SET schema_version=41;
    INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('unrelated','bytes',X'00FF01',1);
    ANALYZE;`);
}
const fixture = migrationFixture({
  seed,
  predecessor: 41,
  target: 42,
  scope: ["agent_tool_usage", "schema_meta"],
  admission: true,
});

it.each(["commit", "rollback"])(
  "adds the empty STRICT ranking table atomically (%s)",
  async (outcome) => {
    await fixture("tool-usage-migration.sqlite", async ({ database, migrate }) => {
      const before = agentWitness(database);
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? 42 : 41);
      expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
        warnings: [],
      });
      if (outcome === "rollback") {
        expect(
          row(database, "SELECT name FROM sqlite_schema WHERE name='agent_tool_usage'"),
        ).toBeUndefined();
        return;
      }
      expect(rows(database, "SELECT * FROM agent_tool_usage")).toEqual([]);
      expect(
        row(database, "SELECT strict FROM pragma_table_list WHERE name='agent_tool_usage'"),
      ).toEqual({ strict: 1 });
      expect(() =>
        database.exec("INSERT INTO agent_tool_usage VALUES ('openclaw:synthetic:lookup',-1,1)"),
      ).toThrow();
      database.exec("INSERT INTO agent_tool_usage VALUES ('openclaw:synthetic:lookup',1,1)");
      expect(() => assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toThrow(
        "Migration added unclassified database content",
      );
    });
  },
);

it("restores a scoped schema41 backup without reverting unrelated writes", async () => {
  await fixture(
    "tool-usage-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(database, "SELECT sql FROM sqlite_schema WHERE name='agent_tool_usage'"),
        version: row(database, "PRAGMA user_version"),
        schemaVersion: row(database, "SELECT schema_version FROM schema_meta"),
      }));
    },
    "state",
  );
});
