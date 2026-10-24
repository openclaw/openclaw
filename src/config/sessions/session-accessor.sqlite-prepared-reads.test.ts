import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { AdmissionOperations } from "../../infra/sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { sessionParticipantsSchemaSql } from "../../state/openclaw-agent-session-participants-schema.js";
import { sessionEntrySnapshotsSchemaSql } from "../../state/openclaw-agent-session-snapshots-schema.js";
import { getExactSessionEntryQueries } from "./session-accessor.sqlite-entry-query.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  type SessionEntrySnapshot,
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "./session-entry-snapshots.js";
import { promptReport } from "./system-prompt-report.test-support.js";

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
  const database = { agentId: "main", db, keys };
  const sql = (query: string) => db.prepare(query);
  const read = (
    key = keys[0],
    projection: Parameters<typeof readExactSessionEntryRowValidated>[2] = "list",
  ) => readExactSessionEntryRowValidated(database, key, projection)?.entry;
  const participant = (id: string) =>
    sql("UPDATE session_participants SET actor_id = ? WHERE session_key = ?").run(id, keys[0]);
  const transact = (write: () => void, commit = true) => {
    db.exec("BEGIN");
    write();
    db.exec(commit ? "COMMIT" : "ROLLBACK");
  };
  return { ...database, sql, read, participant, transact };
}

function addOwnerColumns(db: DatabaseSync) {
  for (const { columnName, dataType } of SESSION_OWNER_COLUMN_DEFINITIONS) {
    db.exec(`ALTER TABLE session_nodes ADD COLUMN ${columnName} ${dataType}`);
  }
}

it("skips absent-field clearing only when the complete previous field set survives", () => {
  const database = createDatabase();
  const {
    keys: [key],
    sql,
    transact,
  } = database;
  const previous = {
    sessionId: "session-0",
    updatedAt: 1,
    skillsSnapshot: { prompt: "saved prompt", skills: [] },
  };
  // Match the initial complete snapshot, including its report.
  const previousEntry = {
    ...previous,
    systemPromptReport: promptReport(1, 0, 0),
  };
  const writes = trackSqliteStatementExecutions(database.db, ["delete"], (query) =>
    /^delete from "session_entry_snapshots"/iu.test(query) ? "delete" : null,
  );
  const replace = (entry: Record<string, unknown>, commit = true) => {
    const split = splitSessionEntrySnapshots(entry, { previousEntry });
    transact(() => writeSessionEntrySnapshots(database, key, split.snapshots, split), commit);
  };
  const fields = () =>
    sql("SELECT field FROM session_entry_snapshots WHERE session_key = ? ORDER BY field")
      .all(key)
      .map((row) => row.field);
  using _ = { [Symbol.dispose]: writes.restore };
  const both = ["skillsSnapshot", "systemPromptReport"];
  for (const [entry, commit, expected, deletions] of [
    [{ ...previousEntry, skillsSnapshot: { prompt: "new prompt", skills: [] } }, true, both, 0],
    [previous, false, both, undefined],
    [previous, true, ["skillsSnapshot"], 2],
  ] as const) {
    replace(entry, commit);
    expect(fields()).toEqual(expected);
    if (deletions !== undefined) {
      expect(writes.counts.delete).toBe(deletions);
    }
  }
  transact(() => writeSessionEntrySnapshots(database, key, []));
  expect(fields()).toEqual([]);
});

it("batches snapshot replacement while preserving values, revisions, and rollback", () => {
  const database = createDatabase();
  const {
    sql,
    read,
    keys: [key, otherKey],
    transact,
  } = database;
  const snapshots: SessionEntrySnapshot[] = [
    { field: "sessionDiffBaseline", valueJson: '{"sessionId":"session-0"}' },
    { field: "skillsSnapshot", valueJson: '{"prompt":"saved prompt","skills":[]}' },
    { field: "systemPromptReport", valueJson: '{"source":"run"}' },
  ];
  const rows = () =>
    sql(
      "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
    ).all(key);
  const revision = () =>
    sql("SELECT snapshot_revision FROM session_nodes WHERE session_key = ?").get(key)
      ?.snapshot_revision;
  const writes = trackSqliteStatementExecutions(database.db, ["writes"], (query) =>
    /^(?:insert into|delete from) "session_entry_snapshots"/iu.test(query) ? "writes" : null,
  );
  const replace = (values: readonly SessionEntrySnapshot[], commit = true) => {
    const before = writes.counts.writes;
    transact(() => writeSessionEntrySnapshots(database, key, values), commit);
    expect.soft(writes.counts.writes - before).toBe(values.length > 0 ? 2 : 1);
  };
  const changedSnapshots: SessionEntrySnapshot[] = [
    snapshots[0]!,
    { field: "skillsSnapshot", valueJson: '{"prompt":"changed prompt","skills":[]}' },
  ];
  const original = snapshots.map(({ field, valueJson }) => ({ field, value_json: valueJson }));
  const changed = [
    { field: "sessionDiffBaseline", value_json: '{"sessionId":"session-0"}' },
    { field: "skillsSnapshot", value_json: '{"prompt":"changed prompt","skills":[]}' },
  ];
  using _ = { [Symbol.dispose]: writes.restore };
  for (const [values, commit, expected, expectedRevision] of [
    [snapshots, true, original, 3],
    [snapshots, true, original, 3],
    [changedSnapshots, true, changed, 5],
    [snapshots, false, changed, 5],
    [[], true, [], 7],
  ] as const) {
    replace(values, commit);
    expect({ rows: rows(), revision: revision() }).toEqual({
      rows: expected,
      revision: expectedRevision,
    });
  }
  expect(read(otherKey, "full")?.skillsSnapshot).toEqual({ prompt: "saved prompt", skills: [] });
});

it("reuses detached entry and participant facts until the transaction changes", () => {
  const database = createDatabase();
  const {
    db,
    participant,
    keys: [key],
  } = database;
  const read = () => readExactSessionEntryRowValidated(database, key, "list");
  read();
  const queries = trackSqliteStatementExecutions(db, ["entries", "participants"], (sql) =>
    sql.includes('from "session_participants"')
      ? "participants"
      : sql.includes('from "session_nodes"')
        ? "entries"
        : null,
  );
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
    db.exec("BEGIN");
    participant("local");
    expect(read()?.entry.participants?.[0]?.identity.id).toBe("local");
    db.exec("SAVEPOINT participant_edit");
    participant("pending");
    expect(read()?.entry.participants?.[0]?.identity.id).toBe("pending");
    db.exec("ROLLBACK TO participant_edit");
    expect(read()?.entry.participants?.[0]?.identity.id).toBe("local");
    db.exec("RELEASE participant_edit");
  } finally {
    db.exec("ROLLBACK");
    queries.restore();
  }
  expect(read()?.entry.participants?.[0]?.identity.id).toBe("participant-0");
});

it.each(["row", "canonical"] as const)(
  "bounds retained %s snapshot bytes while preserving oversized and updated reads",
  (method) => {
    const database = createDatabase();
    const { db, keys, transact } = database;
    const key = keys[0];
    const queries = getExactSessionEntryQueries(db);
    const read = () =>
      runSqliteReadOperationSync(db, () => queries[method](key, "full"))?.skills_snapshot_json;
    const replacePrompt = (prompt: string) =>
      transact(() =>
        writeSessionEntrySnapshots(database, key, [
          { field: "skillsSnapshot", valueJson: JSON.stringify({ prompt, skills: [] }) },
        ]),
      );
    const oversized = "\u0100".repeat(600_000);
    replacePrompt(oversized);
    expect(JSON.parse(read()!).prompt).toBe(oversized);
    const reads = trackSqliteStatementExecutions(db, ["entries"], (sql) =>
      sql.includes('from "session_nodes"') ? "entries" : null,
    );
    using _ = { [Symbol.dispose]: reads.restore };
    for (let count = 1; count <= 2; count++) {
      expect(JSON.parse(read()!).prompt).toBe(oversized);
      expect(reads.counts.entries).toBe(count);
    }
    replacePrompt("small current prompt");
    // A different projection observes the revision before the original shape is revisited.
    runSqliteReadOperationSync(db, () => queries.row(key, "list"));
    expect(JSON.parse(read()!).prompt).toBe("small current prompt");
    const afterRefresh = reads.counts.entries;
    expect(JSON.parse(read()!).prompt).toBe("small current prompt");
    expect(reads.counts.entries).toBe(afterRefresh);
    runSqliteReadOperationSync(db, () => queries.row(keys[1], "list"));
    expect(JSON.parse(read()!).prompt).toBe("small current prompt");
  },
);

it("refreshes warm entry and participant facts after worker receipts and connection reopen", async () => {
  const filename = path.join(tempDirs.make("session-row-freshness-"), "agent.sqlite");
  const { db, read } = createDatabase(filename);
  db.exec("PRAGMA journal_mode=WAL");
  const expectMetadata = (label: string, id: string) =>
    expect(read()).toMatchObject({ label, participants: [{ identity: { id } }] });
  expectMetadata("label-0", "participant-0");
  const probes = trackSqliteStatementExecutions(db, ["fresh"], (sql) =>
    /\bdata_version\b/iu.test(sql) ? "fresh" : null,
  );
  const broker = new SqliteWorkerBroker();
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl: new URL(
        "../../infra/sqlite-database-admission.worker.test-support.ts",
        import.meta.url,
      ),
      databasePath: filename,
      input: undefined,
    });
    const commit = (value: "worker" | "reopened") =>
      broker.runOperation(store!, (scope) =>
        scope.execute({
          type: "writeRows",
          input: {
            sql: `BEGIN IMMEDIATE;
            UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', '${value}')
              WHERE session_key = 'agent:main:first';
            UPDATE session_participants SET actor_id = '${value}'
              WHERE session_key = 'agent:main:first';
            COMMIT;`,
          },
        }),
      );
    await commit("worker");
    expectMetadata("worker", "worker");
    db.close();
    await commit("reopened");
    db.open();
    admitSqliteSchema(db);
    expectMetadata("reopened", "reopened");
    expect(probes.counts.fresh).toBe(0);
  } finally {
    probes.restore();
    await broker.close();
  }
});

it("keeps fresh bindings and participant values without recompiling warm metadata reads", () => {
  const { db, keys, read, sql, participant } = createDatabase();
  for (const key of keys) {
    expect(read(key)?.skillsSnapshot).toBeUndefined();
  }
  const compile = vi.spyOn(getSessionKysely(db).getExecutor(), "compileQuery");
  participant("current-participant");
  sql(
    "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
  ).run("current-label", keys[0]);
  for (let repeat = 0; repeat < 3; repeat += 1) {
    expect(read(keys[0])).toMatchObject({
      sessionId: "session-0",
      label: "current-label",
      participants: [{ identity: { type: "profile", id: "current-participant" } }],
    });
    expect(read(keys[1])).toMatchObject({ sessionId: "session-1", label: "label-1" });
  }
  expect(compile).not.toHaveBeenCalled();
  expect(read("agent:main:missing")).toBeUndefined();
  expect(read(keys[0], "full")?.skillsSnapshot).toMatchObject({ prompt: "saved prompt" });
});

it("refreshes optional owner projections after repeated column removal and creation", () => {
  const { db, read, sql } = createDatabase();
  expect(read()?.owner).toBeUndefined();
  expect(read()?.owner).toBeUndefined();
  for (const ownerId of ["first-owner", "replacement-owner"]) {
    addOwnerColumns(db);
    sql("UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = ?").run(ownerId);
    expect(read()?.owner?.actor).toEqual({ type: "human", id: ownerId });
    sql("UPDATE session_nodes SET owner_actor_id = 'current-owner'").run();
    expect(read()?.owner?.actor.id).toBe("current-owner");
    for (const { columnName } of SESSION_OWNER_COLUMN_DEFINITIONS) {
      db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName}`);
    }
    expect(read()?.owner).toBeUndefined();
  }
});

it("keeps selected snapshots, metadata, and participants inside the caller's current WAL snapshot", () => {
  const filename = path.join(tempDirs.make("session-metadata-snapshot-"), "agent.sqlite");
  const { db, keys, read: readProjection } = createDatabase(filename);
  db.exec("PRAGMA journal_mode=WAL");
  const peer = openNodeSqliteDatabase(filename);
  admitSqliteSchema(peer);
  openedDatabases.push(peer);
  const read = () => readProjection(keys[0], ["systemPromptReport"]);
  expect(read()?.participants?.[0]?.identity.id).toBe("participant-0");
  db.exec("BEGIN");
  expect(read()?.owner).toBeUndefined();
  addOwnerColumns(peer);
  peer.exec("BEGIN IMMEDIATE");
  peer
    .prepare("UPDATE session_nodes SET owner_actor_type = 'human', owner_actor_id = 'peer-owner'")
    .run();
  peer.prepare("UPDATE session_participants SET actor_id = 'peer-participant'").run();
  peer
    .prepare("UPDATE session_entry_snapshots SET value_json = ? WHERE field = 'systemPromptReport'")
    .run('{"source":"run","generatedAt":2}');
  peer.exec("COMMIT");
  const snapshot = read();
  expect([
    snapshot?.owner,
    snapshot?.participants?.[0]?.identity.id,
    snapshot?.systemPromptReport?.generatedAt,
    snapshot?.skillsSnapshot,
  ]).toEqual([undefined, "participant-0", undefined, undefined]);
  db.exec("COMMIT");
  expect(read()).toMatchObject({
    owner: { actor: { id: "peer-owner" } },
    participants: [{ identity: { id: "peer-participant" } }],
    systemPromptReport: { generatedAt: 2 },
  });
});

it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
  "rechecks mutable authorization after metadata preparation",
  () => {
    const { db, read } = createDatabase();
    const expectLabel = () => expect(read()?.label).toBe("label-0");
    expectLabel();
    expectLabel();
    let allow = true;
    db.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
    expectLabel();
    allow = false;
    expect(() => read()).toThrow(/not authorized/iu);
    allow = true;
    expectLabel();
    db.setAuthorizer(null);
    expectLabel();
  },
);
