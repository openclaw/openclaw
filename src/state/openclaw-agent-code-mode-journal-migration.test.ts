import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedVersion,
} from "./schema-migration.test-support.js";

const fixture = migrationFixture({
  seed(database: DatabaseSync) {
    database.exec(getOpenClawAgentMigrationSchema(43));
    seedVersion(database, 43);
    database.exec(
      `PRAGMA foreign_keys=ON;
       INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
         VALUES ('agent:main:retained','retained','{"sessionId":"retained","updatedAt":1}',1);
       INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
         VALUES ('retained','agent:main:retained',1,1);
       INSERT INTO transcript_events (session_id,seq,event_json,created_at)
         VALUES ('retained',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
       INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('unrelated','bytes',X'00FF01',1);
       ANALYZE;`,
    );
  },
  predecessor: 43,
  target: 44,
  scope: ["schema_meta", "session_code_mode_journal"],
});
it.each(["commit", "rollback"])("adds only the empty journal atomically (%s)", async (outcome) => {
  await fixture("code-mode-migration.sqlite", async ({ database, migrate }) => {
    const before = agentWitness(database);
    await migrate(outcome);
    expectVersion(database, outcome === "commit" ? 44 : 43);
    expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
      warnings: [],
    });
    if (outcome === "rollback") {
      expect(
        row(database, "SELECT name FROM sqlite_schema WHERE name='session_code_mode_journal'"),
      ).toBeUndefined();
    } else {
      expect(rows(database, "SELECT * FROM session_code_mode_journal")).toEqual([]);
      expect(
        row(
          database,
          "SELECT strict, wr FROM pragma_table_list WHERE name='session_code_mode_journal'",
        ),
      ).toEqual({ strict: 1, wr: 1 });
      database.exec(`INSERT INTO session_code_mode_journal
        VALUES ('agent:main:retained','retained','execution','tool',1,'{}')`);
      expect(() => assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toThrow(
        /content/u,
      );
      database.exec("DELETE FROM session_code_mode_journal");
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
    }
  });
});
it("restores the scoped predecessor without reverting unrelated writes", async () => {
  await fixture(
    "code-mode-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(
          database,
          "SELECT sql FROM sqlite_schema WHERE name='session_code_mode_journal'",
        ),
        version: row(database, "PRAGMA user_version"),
        metadata: row(database, "SELECT schema_version FROM schema_meta"),
      }));
    },
    "state",
  );
});
it("declares the PostgreSQL predecessor without the journal and one additive forward step", () => {
  const migration = agentEngineSchema.postgresMigrations?.find((step) => step.version === 44);
  expect(migration).toBeDefined();
  expect(migration?.fromSchema.postgres).not.toContain("session_code_mode_journal");
  expect(migration?.schema.postgres).toContain('CREATE TABLE "session_code_mode_journal"');
  expect(migration?.sql).toContain('CREATE TABLE "session_code_mode_journal"');
  expect(migration?.sql).toContain('REFERENCES "session_windows"');
  expect(migration?.sql).toContain('REFERENCES "session_nodes"');
  expect(migration?.sql).toContain('CREATE UNIQUE INDEX "idx_agent_code_mode_journal_tool_call"');
  expect(migration?.sql).not.toContain("\\n");
});
