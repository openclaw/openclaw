import { copyFileSync } from "node:fs";
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import { readExactSessionEntryRow as readEntry } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema as ensureSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "./openclaw-agent-schema-v24.test-support.js";
import { withoutSessionEntrySnapshotsSchema } from "./openclaw-agent-session-snapshots-schema.js";

const fixtureKey = "agent:main:fixture-0";
const row = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params);
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const nodeRows = (db: DatabaseSync) => rows(db, "SELECT * FROM session_nodes ORDER BY session_key");

function migrate(database: DatabaseSync, options: Parameters<typeof ensureSchema>[1]) {
  return withAgentDatabaseMaintenanceLease({ env: options.env }, async () => {
    ensureSchema(database, options);
  });
}
function largeEntry(index: number): SessionEntry {
  const sessionId = `session-${index}`;
  return {
    sessionId,
    updatedAt: 10,
    lifecycleRevision: `revision-${index}`,
    label: `Conversation ${index}`,
    sessionDiffBaseline: {
      version: 1,
      sessionId,
      root: "/synthetic/workspace",
      files: [{ path: "src/component.ts", fingerprint: "a".repeat(64) }],
    },
    skillsSnapshot: { prompt: "p".repeat(40_000), skills: [{ name: "fixture" }], version: 1 },
    systemPromptReport: {
      source: "run",
      generatedAt: 9,
      sessionId,
      systemPrompt: { chars: 40_000, projectContextChars: 0, nonProjectContextChars: 40_000 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 40_000, entries: [{ name: "fixture", blockChars: 40_000 }] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  };
}

function seedV23(database: DatabaseSync, count: number) {
  database.exec(withoutSessionEntrySnapshotsSchema(OPENCLAW_AGENT_SCHEMA_V24_SQL));
  database.exec(`PRAGMA user_version = 23;
    INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 23, 'main', '2026.9.4', 1, 1)`);
  const insert = database.prepare(`INSERT INTO session_nodes
    (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 10)`);
  const entries = new Map<string, SessionEntry>();
  database.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1) {
      const entry = largeEntry(index);
      const key = `agent:main:fixture-${index}`;
      insert.run(key, entry.sessionId, JSON.stringify(entry));
      entries.set(key, entry);
    }
    database.exec(`INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
      VALUES ('session-0', 'agent:main:fixture-0', 1, 10)`);
    const eventJson = ' {"type":"custom","data":{"text":"Snow 雪","duplicate":1,"duplicate":2}}\n';
    database
      .prepare(`INSERT INTO transcript_events(session_id, seq, event_json, created_at)
        VALUES ('session-0', 0, ?, 7)`)
      .run(eventJson);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return entries;
}

function transcriptRows(database: DatabaseSync) {
  return rows(
    database,
    `SELECT rowid, session_id, seq, event_json, event_zstd,
    event_utf8_bytes, navigation_json, created_at FROM transcript_events ORDER BY rowid`,
  );
}
function snapshotRows(database: DatabaseSync) {
  return rows(database, "SELECT * FROM session_entry_snapshots ORDER BY session_key, field");
}
function capture(database: DatabaseSync) {
  return {
    schema: rows(database, "SELECT name, sql FROM sqlite_schema ORDER BY name"),
    nodes: nodeRows(database),
    transcript: transcriptRows(database),
    metadata: rows(database, "SELECT * FROM schema_meta"),
  };
}

it("migrates a copied large v23 store without losing snapshots or rewriting transcript bytes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sourcePath = state.path("source-v23.sqlite");
    const pathname = state.path("candidate.sqlite");
    using source = new DatabaseSync(sourcePath);
    const options = { agentId: "main", path: pathname, env: state.env };
    const rejected = new Map([
      ["malformed", '{"sessionId":"malformed"'],
      ["nul", '{"sessionId":"nul","updatedAt":10,"skillsSnapshot":null}\0'],
      ["mismatch", '{"sessionId":"other","updatedAt":10,"skillsSnapshot":false}'],
      ["retained", "{}"],
    ]);
    const depthJson = `${"[".repeat(1_050)}null${"]".repeat(1_050)}`;
    const legacyValues = {
      sessionId: "legacy-values",
      updatedAt: 10,
      sessionDiffBaseline: ["legacy", null],
      skillsSnapshot: null,
      systemPromptReport: false,
    };
    const entries = seedV23(source, 128);
    expect(Buffer.byteLength(JSON.stringify(entries.get(fixtureKey)))).toBeGreaterThan(35_000);
    const insert = source.prepare(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 10)`);
    for (const [id, entryJson] of rejected) {
      insert.run(`agent:main:${id}`, id, entryJson);
    }
    insert.run("agent:main:legacy-values", legacyValues.sessionId, JSON.stringify(legacyValues));
    insert.run(
      "agent:main:deep",
      "deep",
      `{"sessionId":"deep","updatedAt":10,"skillsSnapshot":${depthJson}}`,
    );
    expect(
      row(source, "SELECT name FROM sqlite_schema WHERE name = 'session_entry_snapshots'"),
    ).toBeUndefined();
    source.close();
    copyFileSync(sourcePath, pathname);
    using database = new DatabaseSync(pathname);
    const beforeTranscript = transcriptRows(database);
    await migrate(database, options);
    expect(row(database, "PRAGMA user_version")).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(row(database, "SELECT schema_version FROM schema_meta")).toEqual({
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(transcriptRows(database)).toEqual(beforeTranscript);
    const reader = { agentId: "main", db: database };
    for (const [key, entry] of entries) {
      expect(readEntry(reader, key)?.entry).toEqual(entry);
    }
    expect(readEntry(reader, "agent:main:legacy-values")?.entry).toEqual(legacyValues);
    expect(JSON.stringify(readEntry(reader, "agent:main:deep")?.entry.skillsSnapshot)).toBe(
      depthJson,
    );
    expect(row(database, "SELECT count(*) AS count FROM session_entry_snapshots")).toEqual({
      count: 388,
    });
    for (const [id, entryJson] of rejected) {
      expect(
        row(
          database,
          "SELECT entry_json FROM session_nodes WHERE session_key = ?",
          `agent:main:${id}`,
        ),
      ).toEqual({ entry_json: entryJson });
    }
    const migratedNodes = nodeRows(database);
    const coldRows = snapshotRows(database);
    database.close();
    using reopened = new DatabaseSync(pathname);
    ensureSchema(reopened, options);
    expect(nodeRows(reopened)).toEqual(migratedNodes);
    expect(snapshotRows(reopened)).toEqual(coldRows);
  });
});

it("rolls back extracted snapshots and version markers when schema publication is refused", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("refused-v23.sqlite");
    using database = new DatabaseSync(pathname);
    seedV23(database, 2);
    const before = capture(database);
    let reachedPublication = false;
    database.setAuthorizer((action, name, value) => {
      if (
        action === constants.SQLITE_PRAGMA &&
        name === "user_version" &&
        value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
      ) {
        reachedPublication = true;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    await expect(
      migrate(database, { agentId: "main", path: pathname, env: state.env }),
    ).rejects.toThrow(/authoriz/i);
    database.setAuthorizer(null);
    expect(reachedPublication).toBe(true);
    expect(row(database, "PRAGMA user_version")).toEqual({ user_version: 23 });
    expect(capture(database)).toEqual(before);
  });
});
