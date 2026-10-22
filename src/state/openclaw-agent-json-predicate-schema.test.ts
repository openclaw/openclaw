import fs from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deriveSessionPredicateColumns } from "../config/sessions/session-predicate-columns.js";
import {
  prepareTranscriptPayload,
  transcriptPredicateSql,
} from "../config/sessions/transcript-payload.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { hasPendingAgentStartupColumns } from "./openclaw-agent-db-additive-columns.js";
import {
  AGENT_JSON_PREDICATE_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "./openclaw-agent-db.test-support.js";
import { migrateAgentJsonPredicatesInTransaction } from "./openclaw-agent-json-predicate-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_V21_SQL,
  restoreEmptyV21StorageForHistoricalFixture,
} from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "./openclaw-agent-schema-v24.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "./openclaw-agent-schema-v25.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness as witness,
  expectVersion as expectSchemaVersion,
  refuseVersion,
  row as readRow,
  rows as readRows,
  seedVersion,
} from "./schema-migration.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

function expectVersion(database: DatabaseSync, version = OPENCLAW_AGENT_SCHEMA_VERSION) {
  expectSchemaVersion(database, version);
}
function admit(database: DatabaseSync, path: string, env: NodeJS.ProcessEnv, register?: boolean) {
  return ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", path, env, register });
}
function migrateLegacyStore(database: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv) {
  return withAgentDatabaseMaintenanceLease({ env }, async () =>
    admit(database, pathname, env, false),
  );
}
function seedSchema(database: DatabaseSync, version: 24 | 25 = 25) {
  database.exec(version === 24 ? OPENCLAW_AGENT_SCHEMA_V24_SQL : OPENCLAW_AGENT_SCHEMA_V25_SQL);
  seedVersion(database, version);
  database.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:main', 'history', '{"sessionId":"history","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES ('history', 'agent:main:main', 1, 1);
  `);
}

describe("agent JSON predicate migration", () => {
  it("keeps transcripts untouched while lazy predicates match canonical writer semantics", () => {
    using database = new DatabaseSync(":memory:");
    seedSchema(database);
    const sessionEntries = [
      "{}",
      '{"sessionStartedAt":null}',
      '{"sessionStartedAt":1.9}',
      '{"sessionStartedAt":-1.9}',
      '{"sessionStartedAt":true}',
      '{"sessionStartedAt":false}',
      '{"sessionStartedAt":"  -12.9e5"}',
      '{"sessionStartedAt":"not a timestamp"}',
      '{"sessionStartedAt":{}}',
      '{"sessionStartedAt":[]}',
      '{"sessionStartedAt":9223372036854775808}',
      '{"sessionStartedAt":-9223372036854775809}',
      '{"sessionStartedAt":9007199254740993}',
      '{"sessionStartedAt":1e999}',
      '{"sessionStartedAt":12,"sessionStartedAt":34}',
      '{"sessionStartedAt\\u0000suffix":12,"sessionStartedAt":34}',
      '{"previousSessionId\\u0000suffix":null}',
      '{"previousSessionId":null}',
      '{"usageFamilySessionIds":[]}',
      '{"compactionCheckpoints":false}',
      "{}\u0000ignored",
      "{",
      `{"sessionStartedAt":1,"nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
    ];
    const insertNode = database.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`);
    for (const [index, entry] of sessionEntries.entries()) {
      insertNode.run(`agent:main:case-${index}`, `case-${index}`, entry);
    }
    const navigationEvents = [
      '{"type":"reset","targetId":"prior"}',
      '{"type":"compaction","firstKeptEntryId":"kept"}',
      '{"type":"message","message":{"role":"assistant"}}',
      '{"type":"custom_message","customType":"openclaw.runtime-context","display":true}',
      '{"type":"custom","customType":"openclaw.cache-ttl","display":1}',
      '{"type":"message","type":"reset","message":{"role":"user","role":"system"}}',
      '{"type":"message","message":{"role":"toolResult"},"message":{"role":"user"}}',
      '{"type":"custom","customType":"openclaw.cache-ttl","customType":"openclaw.runtime-context","display":false}',
    ];
    const events = [
      "{}",
      '{"type":"session","id":"history","version":3}',
      ...navigationEvents,
      '{"t\\u0079pe":"message","type":"reset","message":{"role":"user","r\\u006fle":"system"}}',
      '{"type\\u0000suffix":"message","type":"reset","message\\u0000suffix":{"role\\u0000suffix":"user","role":"assistant"}}',
      '{"customType\\u0000suffix":"openclaw.cache-ttl","customType":"openclaw.runtime-context","display\\u0000suffix":true,"display":false}',
      '{"customType":"openclaw.cache-ttl","customType":"openclaw.runtime-context","display":false}',
      '{"type":"unknown","customType":12,"message":{"role":"unknown"}}',
      '{"type":"message\\u0000","message":{"role":"assistant\\ud800"}}',
      "[]",
      "null",
      "{}\u0000ignored",
      "{",
      `{"type":"message","nested":${"[".repeat(999)}0${"]".repeat(999)}}`,
      `{"type":"message","nested":${"[".repeat(1000)}0${"]".repeat(1000)}}`,
      `{"type":"message","nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
    ];
    const insertEvent = database.prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, created_at) VALUES ('history', ?, ?, 1)`);
    for (const [index, event] of events.entries()) {
      insertEvent.run(index + 1, event);
    }
    // Exercise the same predicates through real stored navigation, not a fabricated envelope.
    const compressedEvents = navigationEvents.map(
      (event) => `${event.slice(0, -1)},"padding":"${"x".repeat(4096)}"}`,
    );
    const compressedPayloads = compressedEvents.map((event) =>
      prepareTranscriptPayload(database, event, undefined, "UTF-8"),
    );
    const insertCompressed = database.prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
      VALUES ('history', ?, NULL, ?, ?, ?, 1)`);
    for (const [index, payload] of compressedPayloads.entries()) {
      expect(payload.event_json, navigationEvents[index]).toBeNull();
      expect(payload.event_zstd, navigationEvents[index]).toBeInstanceOf(Uint8Array);
      insertCompressed.run(
        events.length + index + 1,
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
      );
    }
    const payloads = [
      { payload: {}, state: null },
      { payload: { state: "pending" }, state: "pending" },
      { payload: { state: "ready" }, state: "ready" },
      { payload: { state: null }, state: null },
      { payload: { state: 1 }, state: null },
    ];
    for (const [index, { payload }] of payloads.entries()) {
      database
        .prepare(`INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at) VALUES (?, 'engine', 'history', ?, 1)`)
        .run(String(index), JSON.stringify(payload));
    }
    database.setAuthorizer((action, table) =>
      table === "transcript_events" && action === constants.SQLITE_UPDATE
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      database.exec("BEGIN IMMEDIATE");
      migrateAgentJsonPredicatesInTransaction(database);
      database.exec("COMMIT");
    } finally {
      database.setAuthorizer(null);
    }
    for (const [index, entry] of sessionEntries.entries()) {
      const expected = deriveSessionPredicateColumns(entry);
      expect(
        readRow(
          database,
          `SELECT entry_json, CAST(session_started_at AS TEXT) AS session_started_at,
        has_optional_references FROM session_nodes WHERE session_key = ?`,
          `agent:main:case-${index}`,
        ),
      ).toEqual({
        entry_json: entry,
        session_started_at: expected.session_started_at?.toString() ?? null,
        has_optional_references: expected.has_optional_references,
      });
    }
    const predicates = getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
      .selectFrom("transcript_events")
      .select([
        transcriptPredicateSql(database, "navigation_type").as("navigation_type"),
        transcriptPredicateSql(database, "navigation_custom_type").as("navigation_custom_type"),
        transcriptPredicateSql(database, "navigation_display").as("navigation_display"),
        transcriptPredicateSql(database, "message_role").as("message_role"),
        transcriptPredicateSql(database, "navigation_last_type").as("navigation_last_type"),
        transcriptPredicateSql(database, "navigation_last_custom_type").as(
          "navigation_last_custom_type",
        ),
        transcriptPredicateSql(database, "navigation_valid").as("navigation_valid"),
      ])
      .where("session_id", "=", "history");
    for (const [index, event] of [...events, ...compressedEvents].entries()) {
      expect(
        executeSqliteQueryTakeFirstSync(database, predicates.where("seq", "=", index + 1)),
        event,
      ).toEqual(deriveTranscriptPredicateFields(event));
    }
    expect(
      readRows(database, "SELECT DISTINCT navigation_type, message_role FROM transcript_events"),
    ).toEqual([{ navigation_type: null, message_role: null }]);
    for (const [index, payload] of compressedPayloads.entries()) {
      expect(
        readRow(
          database,
          `SELECT event_zstd, navigation_json FROM transcript_events
        WHERE session_id = 'history' AND seq = ?`,
          events.length + index + 1,
        ),
      ).toEqual({
        event_zstd: new Uint8Array(payload.event_zstd!),
        navigation_json: payload.navigation_json,
      });
    }
    expect(
      readRows(
        database,
        "SELECT event_json FROM transcript_events WHERE event_json IS NOT NULL ORDER BY seq",
      ),
    ).toEqual(events.map((event_json) => ({ event_json })));
    for (const [index, { payload, state }] of payloads.entries()) {
      expect(
        readRow(
          database,
          "SELECT payload_json, payload_state FROM context_engine_turn_outbox WHERE advancement_key = ?",
          String(index),
        ),
      ).toEqual({
        payload_json: JSON.stringify(payload),
        payload_state: state,
      });
    }
  });

  it.each([false, true])(
    "preserves stable-v24 transcripts through admission (rollback=%s)",
    async (rollback) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("predicates-v24.sqlite");
        using database = new DatabaseSync(pathname);
        seedSchema(database, 24);
        // Stable admission has already settled the historical trigger's pending validity flag.
        database.exec("UPDATE session_nodes SET entry_valid = 1");
        const event =
          '{"type":"message","message":{"role":"user","content":"retained stable transcript"}}';
        database
          .prepare(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('history', 1, ?, 1)`)
          .run(event);
        const original = witness(database);
        if (rollback) {
          refuseVersion(database, OPENCLAW_AGENT_SCHEMA_VERSION);
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () => admit(database, pathname, state.env);
          if (rollback) {
            expect(migrate).toThrow(/authoriz/u);
          } else {
            migrate();
          }
        });
        database.setAuthorizer(null);
        expectVersion(database, rollback ? 24 : OPENCLAW_AGENT_SCHEMA_VERSION);
        expect(assertOpenClawMigrationWitnessPreserved(original, witness(database))).toEqual({
          warnings: [],
        });
        expect(readRow(database, "SELECT event_json FROM transcript_events")?.event_json).toBe(
          event,
        );
        if (!rollback) {
          expect(
            readRow(database, "SELECT navigation_type, message_role FROM transcript_events"),
          ).toEqual({ navigation_type: null, message_role: null });
        }
      });
    },
  );

  it.each(["commit", "rollback", "without-outbox", "missing-additive-indexes"] as const)(
    "publishes both version markers only with the complete v26 migration (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("predicates-v25.sqlite");
        using database = new DatabaseSync(pathname);
        seedSchema(database);
        if (outcome === "without-outbox") {
          database.exec("DROP TABLE context_engine_turn_outbox");
        }
        if (outcome === "missing-additive-indexes") {
          database.exec(`
            DROP INDEX idx_agent_transcript_context_pending;
            DROP INDEX idx_agent_session_nodes_label;
            DROP INDEX idx_agent_session_nodes_entry_not_valid;
          `);
        }
        database.exec(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
          VALUES ('history', 1, '{"type":"message","message":{"role":"user"}}', 1)`);
        database.exec("ANALYZE");
        const original = witness(database);
        if (outcome === "rollback") {
          refuseVersion(database, AGENT_JSON_PREDICATE_SCHEMA_VERSION);
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () =>
            ensureOpenClawAgentSchema(
              database,
              "main",
              pathname,
              AGENT_JSON_PREDICATE_SCHEMA_VERSION,
            );
          if (outcome === "rollback") {
            expect(migrate).toThrow(/authoriz/u);
          } else {
            await assertSqliteMigrationScopePreserved(
              database,
              [
                "schema_meta",
                "session_nodes",
                "session_reactions",
                "session_windows",
                "transcript_events",
                "context_engine_turn_outbox",
                "sqlite_stat1",
                "sqlite_stat4",
              ],
              migrate,
            );
          }
        });
        database.setAuthorizer(null);
        const expectedVersion = outcome === "rollback" ? 25 : AGENT_JSON_PREDICATE_SCHEMA_VERSION;
        expectVersion(database, expectedVersion);
        expect(assertOpenClawMigrationWitnessPreserved(original, witness(database))).toEqual({
          warnings: [],
        });
        const columns = readRows(database, "PRAGMA table_info(transcript_events)").map(
          (row) => row.name,
        );
        expect(columns.includes("navigation_type")).toBe(outcome !== "rollback");
        expect(hasPendingAgentStartupColumns(captureSqliteSchemaFacts(database).tableSql)).toBe(
          outcome === "rollback",
        );
        if (outcome === "without-outbox") {
          expect(
            readRow(
              database,
              "SELECT name FROM sqlite_schema WHERE name = 'context_engine_turn_outbox'",
            ),
          ).toBeUndefined();
        }
        if (outcome === "missing-additive-indexes") {
          expect(
            readRows(
              database,
              `SELECT name FROM sqlite_schema WHERE name IN (
              'idx_agent_transcript_context_pending', 'idx_agent_session_nodes_label',
              'idx_agent_session_nodes_entry_not_valid'
            )`,
            ),
          ).toEqual([]);
        }
      });
    },
  );
});

describe("agent outbox sequence migration", () => {
  it.each(["frozen", "restored"] as const)(
    "preserves a v17 outbox through schema admission from %s storage",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("outbox-v17.sqlite");
        using database = new DatabaseSync(pathname);
        database.exec(
          source === "frozen" ? OPENCLAW_AGENT_SCHEMA_V21_SQL : OPENCLAW_AGENT_SCHEMA_SQL,
        );
        if (source === "restored") {
          restoreEmptyV21StorageForHistoricalFixture(database);
        }
        removeCanonicalValidationFromHistoricalAgentFixture(database);
        database.exec("DROP TABLE session_participants");
        seedVersion(database, 17);
        const rows = [
          { enqueue_sequence: -7, advancement_key: "z-first", payload_json: '{"state":"ready"}' },
          { enqueue_sequence: 40, advancement_key: "a-last", payload_json: '{"state":"blocked"}' },
        ];
        const insert = database.prepare(`INSERT INTO context_engine_turn_outbox
          (rowid, advancement_key, engine_id, session_id, payload_json, attempt_count, created_at)
          VALUES (?, ?, 'test', 'session', ?, 3, 1)`);
        for (const row of rows) {
          insert.run(row.enqueue_sequence, row.advancement_key, row.payload_json);
        }
        const indexes = readRows(
          database,
          "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'context_engine_turn_outbox' AND sql IS NOT NULL ORDER BY name",
        );
        await migrateLegacyStore(database, pathname, state.env);
        expectVersion(database);
        expect(readRows(database, "PRAGMA table_info(context_engine_turn_outbox)")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "enqueue_sequence", type: "INTEGER", pk: 1 }),
            expect.objectContaining({ name: "advancement_key", type: "TEXT", notnull: 1, pk: 0 }),
          ]),
        );
        expect(
          readRows(
            database,
            "SELECT enqueue_sequence, advancement_key, payload_json FROM context_engine_turn_outbox ORDER BY enqueue_sequence",
          ),
        ).toEqual(rows);
        expect(
          readRows(
            database,
            "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'context_engine_turn_outbox' AND sql IS NOT NULL ORDER BY name",
          ),
        ).toEqual(indexes);
        expect(() => restoreEmptyV21StorageForHistoricalFixture(database)).toThrow(
          "Historical fixture must not discard context_engine_turn_outbox data",
        );
        expect(() => insert.run(100, "z-first", "{}")).toThrow(/UNIQUE/);
        expect(readRow(database, "PRAGMA integrity_check")?.integrity_check).toBe("ok");
        expect(readRows(database, "PRAGMA foreign_key_check")).toEqual([]);
      });
    },
  );

  it("preserves the previous rowids, payloads and FIFO across migration, vacuum and reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("outbox-v26.sqlite");
      {
        using database = new DatabaseSync(pathname);
        database.exec(
          fs.readFileSync(
            new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
            "utf8",
          ),
        );
        seedVersion(database, 26);
        const insert = database.prepare(`INSERT INTO context_engine_turn_outbox
        (rowid, advancement_key, engine_id, session_id, payload_json, payload_state, attempt_count, last_attempt_at, last_error, created_at)
        VALUES (?, ?, 'test', 'session', ?, ?, 3, 7, 'retry', ?)`);
        insert.run(7, "z-first", '{"state":"ready"}', "ready", 90);
        insert.run(40, "m-blocked", '{"state":"blocked"}', "blocked", 1);
        insert.run(91, "a-last", '{"state":"accepted"}', "accepted", 20);
        const originalRows = readRows(
          database,
          "SELECT rowid AS enqueue_sequence, * FROM context_engine_turn_outbox ORDER BY rowid",
        );
        const original = witness(database);
        await migrateLegacyStore(database, pathname, state.env);
        expectVersion(database);
        expect(assertOpenClawMigrationWitnessPreserved(original, witness(database))).toEqual({
          warnings: [],
        });
        database.exec("VACUUM");
        expect(
          readRows(database, "SELECT * FROM context_engine_turn_outbox ORDER BY enqueue_sequence"),
        ).toEqual(originalRows);
      }
      using reopened = new DatabaseSync(pathname);
      admit(reopened, pathname, state.env, false);
      reopened
        .prepare(`INSERT INTO context_engine_turn_outbox
        (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('new', 'test', 'session', '{}', 0)`)
        .run();
      expect(
        reopened
          .prepare(
            "SELECT enqueue_sequence, advancement_key FROM context_engine_turn_outbox ORDER BY enqueue_sequence",
          )
          .all(),
      ).toEqual([
        { enqueue_sequence: 7, advancement_key: "z-first" },
        { enqueue_sequence: 40, advancement_key: "m-blocked" },
        { enqueue_sequence: 91, advancement_key: "a-last" },
        { enqueue_sequence: 92, advancement_key: "new" },
      ]);
    });
  });
});
