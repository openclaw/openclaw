import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import { sessionParticipantsSchemaSql } from "../../state/openclaw-agent-session-participants-schema.js";
import {
  readExactSessionEntryJson,
  readExactSessionEntryRowValidated,
} from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

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
      spawned_by TEXT, fork_source_session_key TEXT
    );
  `);
  db.exec(sessionParticipantsSchemaSql());
  const keys: [string, string] = ["agent:main:first", "agent:main:second"];
  const insert = db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, 1, NULL, NULL, NULL)");
  for (const [index, key] of keys.entries()) {
    const entry = {
      sessionId: `session-${index}`,
      updatedAt: 1,
      label: `label-${index}`,
      skillsSnapshot: { prompt: "saved prompt", skills: [] },
      systemPromptReport: { source: "run" },
    };
    insert.run(key, entry.sessionId, JSON.stringify(entry));
    db.prepare("INSERT INTO session_participants VALUES (?, ?, ?, 1, 1, 1)").run(
      key,
      '{"type":"profile"}',
      `participant-${index}`,
    );
  }
  admitSqliteSchema(db);
  return { agentId: "main", db, keys };
}

function addOwnerColumns(db: DatabaseSync) {
  for (const { columnName, dataType } of SESSION_OWNER_COLUMN_DEFINITIONS) {
    db.exec(`ALTER TABLE session_nodes ADD COLUMN ${columnName} ${dataType}`);
  }
}

describe("prepared session entry reads", () => {
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
    expect(readExactSessionEntryJson(database, "agent:main:missing")).toBeUndefined();
    expect(readExactSessionEntryJson(database, database.keys[0])).toContain("saved prompt");
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

  it("keeps metadata and participant reads inside the caller's current WAL snapshot", () => {
    const filename = path.join(tempDirs.make("session-metadata-snapshot-"), "agent.sqlite");
    const database = createDatabase(filename);
    database.db.exec("PRAGMA journal_mode=WAL");
    const peer = openNodeSqliteDatabase(filename);
    admitSqliteSchema(peer);
    openedDatabases.push(peer);
    const key = database.keys[0];
    const read = () => readExactSessionEntryRowValidated(database, key, "list")?.entry;
    expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
    database.db.exec("BEGIN");
    expect(read()?.owner).toBeUndefined();
    addOwnerColumns(peer);
    peer.exec("BEGIN IMMEDIATE");
    peer
      .prepare("UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = 'peer-owner'")
      .run();
    peer.prepare("UPDATE session_participants SET actor_id = 'peer-participant'").run();
    peer.exec("COMMIT");
    expect(read()?.owner).toBeUndefined();
    expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
    database.db.exec("COMMIT");
    expect(read()?.owner?.actor.id).toBe("peer-owner");
    expect(read()?.participants?.[0]?.identity.id).toBe("peer-participant");
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
