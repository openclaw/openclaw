import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { sessionParticipantsSchemaSql } from "../../state/openclaw-agent-session-participants-schema.js";
import { sessionEntrySnapshotsSchemaSql } from "../../state/openclaw-agent-session-snapshots-schema.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  type SessionEntrySnapshot,
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "./session-entry-snapshots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const openedDatabases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openedDatabases.splice(0)) {
    database.close();
  }
});

function createDatabase(filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
  openedDatabases.push(db);
  enableNodeSqliteKyselyStatementCache(db);
  db.exec(`
    CREATE TABLE session_key_contract (id INTEGER PRIMARY KEY, main_key TEXT);
    INSERT INTO session_key_contract VALUES (1, 'main');
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE session_nodes (
      session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT,
      updated_at INTEGER, entry_valid INTEGER, parent_session_key TEXT,
      spawned_by TEXT, fork_source_session_key TEXT, snapshot_revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(sessionParticipantsSchemaSql());
  db.exec(sessionEntrySnapshotsSchemaSql(OPENCLAW_AGENT_SCHEMA_SQL));
  const keys: [string, string] = ["agent:main:first", "agent:main:second"];
  const insert = db.prepare(
    "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES (?, ?, ?, 1, 1)",
  );
  db.exec("BEGIN");
  for (const [index, key] of keys.entries()) {
    const entry = {
      sessionId: `session-${index}`,
      updatedAt: 1,
      label: `label-${index}`,
      skillsSnapshot: { prompt: "saved prompt", skills: [] },
      systemPromptReport: { source: "run" },
    };
    const persisted = splitSessionEntrySnapshots(entry);
    insert.run(key, entry.sessionId, persisted.entryJson);
    writeSessionEntrySnapshots({ db }, key, persisted.snapshots);
    db.prepare("INSERT INTO session_participants VALUES (?, ?, ?, 1, 1, 1)").run(
      key,
      '{"type":"profile"}',
      `participant-${index}`,
    );
  }
  db.exec("COMMIT");
  admitSqliteSchema(db);
  return { agentId: "main", db, keys };
}

function addOwnerColumns(db: DatabaseSync) {
  for (const { columnName, dataType } of SESSION_OWNER_COLUMN_DEFINITIONS) {
    db.exec(`ALTER TABLE session_nodes ADD COLUMN ${columnName} ${dataType}`);
  }
}

it("batches snapshot replacement while preserving values, revisions, and rollback", () => {
  const database = createDatabase();
  const key = database.keys[0];
  const snapshots: SessionEntrySnapshot[] = [
    { field: "sessionDiffBaseline", valueJson: '{"sessionId":"session-0"}' },
    { field: "skillsSnapshot", valueJson: '{"prompt":"saved prompt","skills":[]}' },
    { field: "systemPromptReport", valueJson: '{"source":"run"}' },
  ];
  const rows = () =>
    database.db
      .prepare(
        "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
      )
      .all(key);
  const revision = () =>
    database.db
      .prepare("SELECT snapshot_revision FROM session_nodes WHERE session_key = ?")
      .get(key)?.snapshot_revision;
  const sql = trackSqliteStatementExecutions(database.db, ["writes"], (query) =>
    /^(?:insert into|delete from) "session_entry_snapshots"/iu.test(query) ? "writes" : null,
  );
  const replace = (values: readonly SessionEntrySnapshot[], commit = true) => {
    const before = sql.counts.writes;
    database.db.exec("BEGIN");
    writeSessionEntrySnapshots(database, key, values);
    database.db.exec(commit ? "COMMIT" : "ROLLBACK");
    expect.soft(sql.counts.writes - before).toBe(values.length > 0 ? 2 : 1);
  };
  try {
    replace(snapshots);
    expect(rows()).toEqual([
      { field: "sessionDiffBaseline", value_json: '{"sessionId":"session-0"}' },
      { field: "skillsSnapshot", value_json: '{"prompt":"saved prompt","skills":[]}' },
      { field: "systemPromptReport", value_json: '{"source":"run"}' },
    ]);
    expect(revision()).toBe(3);

    replace(snapshots);
    expect(revision()).toBe(3);

    replace([
      snapshots[0]!,
      { field: "skillsSnapshot", valueJson: '{"prompt":"changed prompt","skills":[]}' },
    ]);
    const changed = [
      { field: "sessionDiffBaseline", value_json: '{"sessionId":"session-0"}' },
      { field: "skillsSnapshot", value_json: '{"prompt":"changed prompt","skills":[]}' },
    ];
    expect(rows()).toEqual(changed);
    expect(revision()).toBe(5);

    replace(snapshots, false);
    expect(rows()).toEqual(changed);
    expect(revision()).toBe(5);

    replace([]);
    expect(rows()).toEqual([]);
    expect(revision()).toBe(7);
    expect(
      readExactSessionEntryRowValidated(database, database.keys[1])?.entry.skillsSnapshot,
    ).toEqual({ prompt: "saved prompt", skills: [] });
  } finally {
    sql.restore();
  }
});

describe("prepared session entry reads", () => {
  it("reuses detached entry and participant facts until the transaction changes", () => {
    const database = createDatabase();
    const key = database.keys[0];
    const read = () => readExactSessionEntryRowValidated(database, key, "list");
    read();
    const queries = trackSqliteStatementExecutions(
      database.db,
      ["entries", "participants"],
      (sql) =>
        sql.includes('from "session_participants"')
          ? "participants"
          : sql.includes('from "session_nodes"')
            ? "entries"
            : null,
    );
    database.db.exec("BEGIN");
    try {
      const first = read()!;
      first.entry.label = "caller-owned";
      first.row.entry_json = "{}";
      first.entry.participants![0]!.identity.id = "caller-owned";
      for (let repeat = 0; repeat < 3; repeat++) {
        expect(read()?.entry).toMatchObject({
          label: "label-0",
          participants: [{ identity: { id: "participant-0" } }],
        });
      }
      expect(queries.counts).toEqual({ entries: 0, participants: 0 });

      database.db
        .prepare("UPDATE session_participants SET actor_id = 'local' WHERE session_key = ?")
        .run(key);
      expect(read()?.entry.participants?.[0]?.identity.id).toBe("local");
      database.db.exec("SAVEPOINT participant_edit");
      database.db
        .prepare("UPDATE session_participants SET actor_id = 'pending' WHERE session_key = ?")
        .run(key);
      expect(read()?.entry.participants?.[0]?.identity.id).toBe("pending");
      database.db.exec("ROLLBACK TO participant_edit");
      expect(read()?.entry.participants?.[0]?.identity.id).toBe("local");
      database.db.exec("RELEASE participant_edit");
    } finally {
      database.db.exec("ROLLBACK");
      queries.restore();
    }
    expect(read()?.entry.participants?.[0]?.identity.id).toBe("participant-0");
  });

  it("refreshes warm row facts after data-only foreign commits and connection reopen", () => {
    const filename = path.join(tempDirs.make("session-row-freshness-"), "agent.sqlite");
    const database = createDatabase(filename);
    database.db.exec("PRAGMA journal_mode=WAL");
    const peer = new DatabaseSync(filename);
    openedDatabases.push(peer);
    const key = database.keys[0];
    const read = () => readExactSessionEntryRowValidated(database, key, "list")?.entry;
    const commit = (value: string) => {
      peer.exec("BEGIN IMMEDIATE");
      peer
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
        )
        .run(value, key);
      peer
        .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
        .run(value, key);
      peer.exec("COMMIT");
    };
    expect(read()?.label).toBe("label-0");
    expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
    commit("foreign");
    expect(read()).toMatchObject({
      label: "foreign",
      participants: [{ identity: { id: "foreign" } }],
    });
    database.db.close();
    commit("reopened");
    database.db.open();
    admitSqliteSchema(database.db);
    expect(read()).toMatchObject({
      label: "reopened",
      participants: [{ identity: { id: "reopened" } }],
    });
  });

  it("keeps fresh bindings and participant values without recompiling warm metadata reads", () => {
    const database = createDatabase();
    const read = (key: string) => readExactSessionEntryRowValidated(database, key, "list")?.entry;
    for (const key of database.keys) {
      expect(read(key)?.skillsSnapshot).toBeUndefined();
    }
    const compile = vi.spyOn(getSessionKysely(database.db).getExecutor(), "compileQuery");
    database.db
      .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
      .run("current-participant", database.keys[0]);
    database.db
      .prepare(
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
      )
      .run("current-label", database.keys[0]);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      expect(read(database.keys[0])).toMatchObject({
        sessionId: "session-0",
        label: "current-label",
        participants: [{ identity: { type: "profile", id: "current-participant" } }],
      });
      expect(read(database.keys[1])).toMatchObject({ sessionId: "session-1", label: "label-1" });
    }
    expect(compile).not.toHaveBeenCalled();
    expect(read("agent:main:missing")).toBeUndefined();
    expect(
      readExactSessionEntryRowValidated(database, database.keys[0])?.entry.skillsSnapshot,
    ).toMatchObject({ prompt: "saved prompt" });
  });

  it("refreshes optional owner projections after repeated column removal and creation", () => {
    const database = createDatabase();
    const key = database.keys[0];
    const read = () => readExactSessionEntryRowValidated(database, key, "list")?.entry;
    expect(read()?.owner).toBeUndefined();
    expect(read()?.owner).toBeUndefined();
    for (const ownerId of ["first-owner", "replacement-owner"]) {
      addOwnerColumns(database.db);
      database.db
        .prepare("UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = ?")
        .run(ownerId);
      expect(read()?.owner?.actor).toEqual({ type: "human", id: ownerId });
      database.db.prepare("UPDATE session_nodes SET owner_actor_id = 'current-owner'").run();
      expect(read()?.owner?.actor.id).toBe("current-owner");
      for (const { columnName } of SESSION_OWNER_COLUMN_DEFINITIONS) {
        database.db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName}`);
      }
      expect(read()?.owner).toBeUndefined();
    }
  });

  it("keeps selected snapshots, metadata, and participants inside the caller's current WAL snapshot", () => {
    const filename = path.join(tempDirs.make("session-metadata-snapshot-"), "agent.sqlite");
    const database = createDatabase(filename);
    database.db.exec("PRAGMA journal_mode=WAL");
    const peer = openNodeSqliteDatabase(filename);
    admitSqliteSchema(peer);
    openedDatabases.push(peer);
    const key = database.keys[0];
    const read = () =>
      readExactSessionEntryRowValidated(database, key, ["systemPromptReport"])?.entry;
    expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
    database.db.exec("BEGIN");
    expect(read()?.owner).toBeUndefined();
    addOwnerColumns(peer);
    peer.exec("BEGIN IMMEDIATE");
    peer
      .prepare("UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = 'peer-owner'")
      .run();
    peer.prepare("UPDATE session_participants SET actor_id = 'peer-participant'").run();
    peer
      .prepare(
        "UPDATE session_entry_snapshots SET value_json = ? WHERE field = 'systemPromptReport'",
      )
      .run('{"source":"run","generatedAt":2}');
    peer.exec("COMMIT");
    expect(read()?.owner).toBeUndefined();
    expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
    expect(read()?.systemPromptReport?.generatedAt).toBeUndefined();
    expect(read()?.skillsSnapshot).toBeUndefined();
    database.db.exec("COMMIT");
    expect(read()?.owner?.actor.id).toBe("peer-owner");
    expect(read()?.participants?.[0]?.identity.id).toBe("peer-participant");
    expect(read()?.systemPromptReport?.generatedAt).toBe(2);
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "rechecks mutable authorization after metadata preparation",
    () => {
      const database = createDatabase();
      const read = () => readExactSessionEntryRowValidated(database, database.keys[0], "list");
      expect(read()?.entry.label).toBe("label-0");
      expect(read()?.entry.label).toBe("label-0");
      let allow = true;
      database.db.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
      expect(read()?.entry.label).toBe("label-0");
      allow = false;
      expect(read).toThrow(/not authorized/iu);
      allow = true;
      expect(read()?.entry.label).toBe("label-0");
      database.db.setAuthorizer(null);
      expect(read()?.entry.label).toBe("label-0");
    },
  );
});
