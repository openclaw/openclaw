import { copyFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readSessionEntryCacheValidityToken } from "../config/sessions/session-accessor.sqlite-entry-revision.js";
import {
  readSessionEntrySelectionSnapshot,
  readUnchangedLifecycleTargetSnapshot,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { getSessionEntryWriteQueries } from "../config/sessions/session-accessor.sqlite-entry-write-queries.js";
import { bindSessionNode } from "../config/sessions/session-accessor.sqlite-session-row.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { withoutSessionEntrySnapshotsSchema } from "./openclaw-agent-session-snapshots-schema.js";

function largeEntry(index: number): SessionEntry {
  const sessionId = `session-${index}`;
  return {
    sessionId,
    updatedAt: 10,
    lifecycleRevision: `revision-${index}`,
    label: `Conversation ${index}`,
    delivery: { kind: "none" },
    sessionDiffBaseline: {
      version: 1,
      sessionId,
      root: "/synthetic/workspace",
      files: Array.from({ length: 80 }, (_, file) => ({
        path: `src/features/feature-${file}/component.ts`,
        fingerprint: "a".repeat(64),
      })),
    },
    skillsSnapshot: { prompt: "p".repeat(25_000), skills: [{ name: "fixture" }], version: 1 },
    systemPromptReport: {
      source: "run",
      generatedAt: 9,
      sessionId,
      systemPrompt: { chars: 25_000, projectContextChars: 0, nonProjectContextChars: 25_000 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 25_000, entries: [{ name: "fixture", blockChars: 25_000 }] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  };
}

function seedV23(database: DatabaseSync, count: number) {
  database.exec(withoutSessionEntrySnapshotsSchema(OPENCLAW_AGENT_SCHEMA_SQL));
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
  return database.prepare("SELECT rowid, * FROM transcript_events ORDER BY rowid").all();
}

function snapshotRows(database: DatabaseSync) {
  return database
    .prepare("SELECT * FROM session_entry_snapshots ORDER BY session_key, field")
    .all();
}

it("migrates a copied large v23 store without losing snapshots or rewriting transcript bytes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sourcePath = state.path("source-v23.sqlite");
    const pathname = state.path("candidate.sqlite");
    const source = new DatabaseSync(sourcePath);
    let entries: ReturnType<typeof seedV23>;
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
    try {
      entries = seedV23(source, 128);
      expect(
        Buffer.byteLength(JSON.stringify(entries.get("agent:main:fixture-0"))),
      ).toBeGreaterThan(35_000);
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
        source
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_entry_snapshots'")
          .get(),
      ).toBeUndefined();
    } finally {
      source.close();
    }
    copyFileSync(sourcePath, pathname);
    let database = new DatabaseSync(pathname);
    try {
      const beforeTranscript = transcriptRows(database);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          path: pathname,
          env: state.env,
        });
      });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(database.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(transcriptRows(database)).toEqual(beforeTranscript);
      const reader = { agentId: "main", db: database };
      for (const [key, entry] of entries) {
        expect(readExactSessionEntryRow(reader, key)?.entry).toEqual(entry);
      }
      expect(readExactSessionEntryRow(reader, "agent:main:legacy-values")?.entry).toEqual(
        legacyValues,
      );
      expect(
        JSON.stringify(readExactSessionEntryRow(reader, "agent:main:deep")?.entry.skillsSnapshot),
      ).toBe(depthJson);
      expect(
        database.prepare("SELECT count(*) AS count FROM session_entry_snapshots").get(),
      ).toEqual({ count: 388 });
      for (const [id, entryJson] of rejected) {
        expect(
          database
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(`agent:main:${id}`),
        ).toEqual({ entry_json: entryJson });
      }
      const migratedNodes = database
        .prepare("SELECT * FROM session_nodes ORDER BY session_key")
        .all();
      const coldRows = snapshotRows(database);
      database.close();
      database = new DatabaseSync(pathname);
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        path: pathname,
        env: state.env,
      });
      expect(database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
        migratedNodes,
      );
      expect(snapshotRows(database)).toEqual(coldRows);
      database.close();
      const options = { agentId: "main", path: pathname, env: state.env };
      const opened = openOpenClawAgentDatabase(options);
      const readRevision = () =>
        opened.db
          .prepare(
            "SELECT snapshot_revision FROM session_nodes WHERE session_key = 'agent:main:fixture-0'",
          )
          .get();
      const migratedRevision = readRevision();
      runOpenClawAgentWriteTransaction((current) => {
        const entry = readExactSessionEntryRow(current, "agent:main:fixture-0")!.entry;
        writeSessionEntry(
          current,
          "agent:main:fixture-0",
          { ...entry, label: "Renamed" },
          { canonicalPreviousEntry: entry },
        );
      }, options);
      expect(readExactSessionEntryRow(opened, "agent:main:fixture-0")?.entry.label).toBe("Renamed");
      expect(snapshotRows(opened.db)).toEqual(coldRows);
      expect(readRevision()).toEqual(migratedRevision);
      expect(transcriptRows(opened.db)).toEqual(beforeTranscript);
      const prepared = readSessionEntrySelectionSnapshot(opened, "agent:main:fixture-0", true);
      const revision = readSessionEntryCacheValidityToken(opened.db);
      opened.db.exec("BEGIN");
      try {
        opened.db
          .prepare(`UPDATE session_entry_snapshots SET value_json = ?
            WHERE session_key = 'agent:main:fixture-0' AND field = 'skillsSnapshot'`)
          .run(JSON.stringify({ prompt: "Changed outside the entry writer", skills: [] }));
        expect(readUnchangedLifecycleTargetSnapshot(opened, prepared)).toBeUndefined();
        expect(readSessionEntryCacheValidityToken(opened.db)).not.toEqual(revision);
        expect(
          readExactSessionEntryRow(opened, "agent:main:fixture-0")?.entry.skillsSnapshot?.prompt,
        ).toBe("Changed outside the entry writer");
      } finally {
        opened.db.exec("ROLLBACK");
      }
      expect(readUnchangedLifecycleTargetSnapshot(opened, prepared)).toBe(prepared);
      expect(readSessionEntryCacheValidityToken(opened.db)).toEqual(revision);
      expect(readRevision()).toEqual(migratedRevision);
      expect(snapshotRows(opened.db)).toEqual(coldRows);
    } finally {
      if (database.isOpen) {
        database.close();
      }
    }
  });
});

it("rolls back extracted snapshots and version markers when schema publication is refused", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("refused-v23.sqlite");
    const database = new DatabaseSync(pathname);
    try {
      seedV23(database, 2);
      const before = {
        schema: database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
        nodes: database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
        transcript: transcriptRows(database),
        metadata: database.prepare("SELECT * FROM schema_meta").all(),
      };
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
        withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            path: pathname,
            env: state.env,
          });
        }),
      ).rejects.toThrow(/authoriz/i);
      database.setAuthorizer(null);
      expect(reachedPublication).toBe(true);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 23 });
      expect(database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
        before.schema,
      );
      expect(database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
        before.nodes,
      );
      expect(database.prepare("SELECT * FROM schema_meta").all()).toEqual(before.metadata);
      expect(transcriptRows(database)).toEqual(before.transcript);
    } finally {
      database.setAuthorizer(null);
      database.close();
    }
  });
});

const key = "agent:main:validity";
const entry = { sessionId: "validity-session", updatedAt: 1 };

function observeUpdates(database: DatabaseSync) {
  database.exec(`
    CREATE TEMP TABLE node_updates (updates INTEGER, clears INTEGER);
    INSERT INTO node_updates VALUES (0, 0);
    CREATE TEMP TRIGGER count_node_updates AFTER UPDATE ON main.session_nodes
    BEGIN
      UPDATE node_updates SET updates = updates + 1, clears = clears + (NEW.entry_valid = 0);
    END;
  `);
  return () => database.prepare("SELECT * FROM node_updates").get();
}

function seedV24(database: DatabaseSync) {
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  database.exec(`
    DROP TRIGGER IF EXISTS session_nodes_entry_valid_after_update;
    CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_entry_update
    AFTER UPDATE OF entry_json ON session_nodes
    BEGIN
      UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
    END;
    CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_identity_update
    AFTER UPDATE OF current_session_id, updated_at ON session_nodes
    BEGIN
      UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
    END;
    PRAGMA user_version = 24;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', 24, 'main', 1, 1);
  `);
  const queries = getSessionEntryWriteQueries(database);
  const node = bindSessionNode({
    entry,
    entryJson: JSON.stringify(entry),
    sessionKey: key,
    updatedAt: 1,
  });
  queries.node(node);
  queries.markValid(key);
  database
    .prepare(`INSERT INTO session_windows(session_id, session_key, created_at, updated_at)
    VALUES (?, ?, 1, 1)`)
    .run(entry.sessionId, key);
  return { queries, node };
}

it("replaces v24 triggers atomically and preserves raw invalidation and canonical settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", path: state.path("v24.sqlite"), env: state.env };
    let database = new DatabaseSync(options.path);
    try {
      const { queries, node } = seedV24(database);
      const updates = observeUpdates(database);
      database.exec("BEGIN");
      queries.node(node);
      queries.markValid(key);
      expect(updates()).toEqual({ updates: 4, clears: 2 });
      database.exec("ROLLBACK");
      const before = database.prepare("SELECT * FROM session_nodes").all();
      const beforeSchema = database
        .prepare("SELECT name, sql FROM sqlite_schema ORDER BY name")
        .all();
      database.close();
      database = new DatabaseSync(options.path);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        let publicationReached = false;
        database.setAuthorizer((action, name, value) => {
          if (action === constants.SQLITE_PRAGMA && name === "user_version" && value === "25") {
            publicationReached = true;
            return constants.SQLITE_DENY;
          }
          return constants.SQLITE_OK;
        });
        try {
          expect(() => ensureOpenClawAgentDatabaseSchema(database, options)).toThrow(/authoriz/i);
        } finally {
          database.setAuthorizer(null);
        }
        expect(publicationReached).toBe(true);
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 24 });
        expect(database.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: 24,
        });
        expect(database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
          beforeSchema,
        );
        expect(database.prepare("SELECT * FROM session_nodes").all()).toEqual(before);
        ensureOpenClawAgentDatabaseSchema(database, options);
      });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
      expect(database.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 25,
      });
      expect(database.prepare("SELECT * FROM session_nodes").all()).toEqual(before);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'session_nodes_entry_valid_*' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "session_nodes_entry_valid_after_insert" },
        { name: "session_nodes_entry_valid_after_update" },
      ]);
      assertCanonicalSessionValidationSchema(database);
      database.close();
      const opened = openOpenClawAgentDatabase(options);
      const countUpdates = observeUpdates(opened.db);
      const token = readSessionEntryCacheValidityToken(opened.db);
      const beforeWrite = opened.db.prepare("SELECT * FROM session_nodes").all();
      for (const set of [
        "entry_json = entry_json || ' '",
        "current_session_id = 'raw-session'",
        "updated_at = 2",
        "entry_json = entry_json, current_session_id = current_session_id, updated_at = updated_at",
      ]) {
        opened.db.exec("BEGIN; DELETE FROM session_canonical_validation_pending");
        opened.db.exec(`UPDATE session_nodes SET ${set}`);
        expect(countUpdates()).toEqual({ updates: 2, clears: 1 });
        expect(opened.db.prepare("SELECT entry_valid FROM session_nodes").get()).toEqual({
          entry_valid: 0,
        });
        expect(
          opened.db.prepare("SELECT session_key FROM session_canonical_validation_pending").all(),
        ).toEqual([{ session_key: key }]);
        expect(readSessionEntryCacheValidityToken(opened.db).sessionNodesGeneration).toBe(
          token.sessionNodesGeneration + 2,
        );
        opened.db.exec("ROLLBACK");
        expect(countUpdates()).toEqual({ updates: 0, clears: 0 });
        expect(opened.db.prepare("SELECT * FROM session_nodes").all()).toEqual(beforeWrite);
        expect(readSessionEntryCacheValidityToken(opened.db)).toEqual(token);
      }
      runOpenClawAgentWriteTransaction((current) => {
        writeSessionEntry(
          current,
          key,
          { ...entry, label: "Renamed" },
          { canonicalPreviousEntry: entry },
        );
      }, options);
      expect(countUpdates()).toEqual({ updates: 3, clears: 1 });
      expect(opened.db.prepare("SELECT entry_valid, label FROM session_nodes").get()).toEqual({
        entry_valid: 1,
        label: "Renamed",
      });
      expect(opened.db.prepare("SELECT * FROM session_canonical_validation_pending").all()).toEqual(
        [],
      );
      expect(readSessionEntryCacheValidityToken(opened.db).sessionNodesGeneration).toBe(
        token.sessionNodesGeneration + 3,
      );
    } finally {
      if (database.isOpen) {
        database.setAuthorizer(null);
        database.close();
      }
    }
  });
});
