import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { migrateAgentColdNavigationInTransaction } from "./openclaw-agent-cold-navigation-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV38Schema,
} from "./schema-migration.test-support.js";

function seed(db: DatabaseSync) {
  seedAgentV38Schema(db);
  runSqliteImmediateTransactionSync(db, () => migrateAgentColdNavigationInTransaction(db));
  db.exec(`PRAGMA user_version=39; UPDATE schema_meta SET schema_version=39;
    INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
      VALUES ('agent:main:retained','retained','{"sessionId":"retained","updatedAt":1}',1);
    INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
      VALUES ('retained','agent:main:retained',1,1);
    INSERT INTO transcript_events (session_id,seq,event_json,created_at)
      VALUES ('retained',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
    INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('fixture','bytes',X'00FF01',1);`);
}
const fixture = migrationFixture({
  seed,
  predecessor: 39,
  target: 40,
  scope: ["schema_meta", "session_creation_operations"],
});
it.each(["commit", "rollback"])(
  "creation receipt schema preserves existing data on %s",
  async (outcome) => {
    await fixture("creation-receipts.sqlite", async ({ database, migrate }) => {
      const before = agentWitness(database);
      expect(
        row(database, "SELECT name FROM sqlite_schema WHERE name='session_creation_operations'"),
      ).toBeUndefined();
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? 40 : 39);
      expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
        warnings: [],
      });
      if (outcome === "commit") {
        expect(rows(database, "SELECT * FROM session_creation_operations")).toEqual([]);
        database.exec(`INSERT INTO session_creation_operations
          (operation_digest,request_fingerprint,session_key,session_id,scopes_json,expires_at)
          VALUES ('unexpected','request','agent:main:retained','retained','[]',1)`);
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(before, agentWitness(database)),
        ).toThrow(/content/u);
        expect(
          row(
            database,
            "SELECT name FROM sqlite_schema WHERE name='idx_agent_session_creation_operations_expiry'",
          ),
        ).toEqual({ name: "idx_agent_session_creation_operations_expiry" });
      } else {
        expect(
          row(database, "SELECT name FROM sqlite_schema WHERE name='session_creation_operations'"),
        ).toBeUndefined();
      }
    });
  },
);
