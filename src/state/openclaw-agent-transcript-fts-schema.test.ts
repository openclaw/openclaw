import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { withoutTranscriptFtsRowSchema } from "./openclaw-agent-transcript-fts-schema.js";

function createHistoricalDatabase(pathname: string): DatabaseSync {
  const database = new DatabaseSync(pathname);
  database.exec(withoutTranscriptFtsRowSchema(OPENCLAW_AGENT_SCHEMA_SQL));
  database.exec(`
    PRAGMA user_version = 21;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 21, 'main', 1, 1);
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:retained', 'retained', '{"sessionId":"retained","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('retained', 'agent:main:retained', 1, 1);
    INSERT INTO session_transcript_index_state
      (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, updated_at)
      VALUES ('retained', 1, 0, 2, 2, 1);
    INSERT INTO session_transcript_fts (rowid, session_id, message_id, text)
      VALUES (17, 'retained', 'first', 'preserved first'),
             (79, 'retained', 'second', 'preserved second');
  `);
  return database;
}

describe("agent transcript FTS row ownership migration", () => {
  it("preserves FTS rows without backfilling and invalidates each legacy projection once", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("legacy-fts.sqlite");
      const database = createHistoricalDatabase(pathname);
      const options = { agentId: "main", env: state.env, path: pathname };
      try {
        const before = database.prepare("SELECT rowid, * FROM session_transcript_fts").all();
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, options);
        });
        expect(database.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(
          before,
        );
        expect(database.prepare("SELECT * FROM session_transcript_fts_rows").all()).toEqual([]);
        expect(
          database
            .prepare("SELECT needs_rebuild, fts_row_count FROM session_transcript_index_state")
            .get(),
        ).toEqual({ needs_rebuild: 1, fts_row_count: null });
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        database.exec(`
          INSERT INTO session_transcript_fts_rows (session_id, fts_rowid) VALUES ('retained', 17), ('retained', 79);
          UPDATE session_transcript_index_state SET needs_rebuild = 0, fts_row_count = 2;
        `);
        ensureOpenClawAgentDatabaseSchema(database, options);
        expect(
          database
            .prepare("SELECT needs_rebuild, fts_row_count FROM session_transcript_index_state")
            .get(),
        ).toEqual({ needs_rebuild: 0, fts_row_count: 2 });
      } finally {
        database.close();
      }
    });
  });

  it("rolls back mapping installation, invalidation and both version markers together", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("interrupted-fts.sqlite");
      const database = createHistoricalDatabase(pathname);
      try {
        const before = database.prepare("SELECT rowid, * FROM session_transcript_fts").all();
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
          try {
            expect(() =>
              ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                env: state.env,
                path: pathname,
              }),
            ).toThrow(/authoriz/u);
          } finally {
            database.setAuthorizer(null);
          }
        });
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(21);
        expect(database.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(
          before,
        );
        expect(
          database.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()
            ?.needs_rebuild,
        ).toBe(0);
        expect(
          database
            .prepare("PRAGMA table_info(session_transcript_index_state)")
            .all()
            .some((row) => row.name === "fts_row_count"),
        ).toBe(false);
        expect(
          database
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_transcript_fts_rows'")
            .get(),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });
});
