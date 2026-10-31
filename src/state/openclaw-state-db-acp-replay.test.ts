import fs from "node:fs";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { expectAcpReplayUtf8Accounting } from "../acp/event-ledger.test-support.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

function seedLegacyReplay(db: EngineConnection) {
  const session = db.prepare(`INSERT INTO acp_replay_sessions
    (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
    VALUES (?, ?, ?, 1, 123, 456, 5, ?)`);
  const event = db.prepare(`INSERT INTO acp_replay_events
    (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
    VALUES (?, ?, 321, ?, ?, ?, ?)`);
  const update =
    '{ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "漢😀\\u0000\\ud800" } }  ';
  for (const [index, estimate] of [0, 17, 9000].entries()) {
    const id = `session-${index}-漢\0\ud800`;
    session.run(id, "key😀", "/é/e\u0301/台\0😀", estimate);
    for (let seq = 1; seq <= 3; seq++) {
      event.run(id, seq, "key😀\0", seq % 2 ? null : "run-\udc00", update, estimate);
    }
  }
  // Even already-correct event estimates must contribute to a repaired aggregate.
  event.run("session-0-漢\0\ud800", 4, "ascii", null, "{}", 56);
  db.exec(
    "UPDATE schema_meta SET app_version = 'synthetic-previous-build' WHERE meta_key = 'primary'",
  );
}

function rows(db: EngineConnection, table: "sessions" | "events", columns: string) {
  const order = table === "events" ? "session_id, seq" : "session_id";
  return db.prepare(`SELECT ${columns} FROM acp_replay_${table} ORDER BY ${order}`).all();
}

const canonicalColumns = {
  sessions: "session_id, session_key, cwd, complete, created_at, updated_at, next_seq",
  events: "session_id, seq, at, session_key, run_id, update_json",
};
function canonicalReplay(db: EngineConnection) {
  return {
    sessions: rows(db, "sessions", canonicalColumns.sessions),
    events: rows(db, "events", canonicalColumns.events),
  };
}

function estimates(db: EngineConnection) {
  return {
    sessions: rows(db, "sessions", "estimated_bytes"),
    events: rows(db, "events", "estimated_bytes"),
    version: db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  };
}

const dropAccounting = `ALTER TABLE acp_replay_events DROP COLUMN estimated_bytes;
  ALTER TABLE acp_replay_sessions DROP COLUMN estimated_bytes;`;
const schemaChanges = {
  current: "",
  "missing-column": "ALTER TABLE template_installs DROP COLUMN bootstrap_source_path",
  "ordered-column": "ALTER TABLE worktrees DROP COLUMN provisioned_paths_json",
  "sandbox-column": "ALTER TABLE sandbox_registry_entries DROP COLUMN image",
  "cron-description": "ALTER TABLE cron_jobs DROP COLUMN description",
  "index-drift": `DROP INDEX idx_plugin_state_listing;
    CREATE INDEX idx_plugin_state_listing
      ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);`,
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function replayFixture(encoding?: string) {
  const options = { path: path.join(tempDirs.make("openclaw-acp-repair-"), "state.sqlite") };
  if (encoding) {
    using seed = new DatabaseSync(options.path);
    seed.exec(
      `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
    );
  }
  const initial = openOpenClawStateDatabase(options).db;
  seedLegacyReplay(initial);
  const before = canonicalReplay(initial),
    oldEstimates = estimates(initial);
  const open = () => openOpenClawStateDatabase(options).db;
  const assertRepaired = (db = open()) => {
    expectAcpReplayUtf8Accounting(requireNativeSqliteDatabase(db));
    expect(canonicalReplay(db)).toEqual(before);
    return db;
  };
  const historicalReadGuard = <T>(operation: () => T | Promise<T>, columns?: string[]) =>
    withoutHistoricalPayloadReads(options.path, operation, columns);
  const runtime = () => historicalReadGuard(open);
  return {
    options,
    initial,
    before,
    oldEstimates,
    assertRepaired,
    historicalReadGuard,
    runtime,
    repair() {
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      return assertRepaired();
    },
    async reopen() {
      closeOpenClawStateDatabaseForTest();
      const db = await runtime();
      expect(db.prepare("SELECT total_changes() AS count").get()?.count).toBe(0);
      return db;
    },
    assertUnchanged(db: EngineConnection) {
      expect(estimates(db)).toMatchObject({
        sessions: oldEstimates.sessions,
        events: oldEstimates.events,
      });
      expect(canonicalReplay(db)).toEqual(before);
    },
  };
}

async function withoutHistoricalPayloadReads<T>(
  pathname: string,
  operation: () => T | Promise<T>,
  columns = [
    "acp_replay_events.update_json",
    "acp_replay_sessions.estimated_bytes",
    "subagent_runs.payload_json",
    "task_runs.delivery_status",
    "operator_approvals.resolution_ref",
    "cron_jobs.job_json",
    "delivery_queue_entries.entry_json",
  ],
): Promise<T> {
  const open = nodeSqlite.openNodeSqliteDatabase;
  const databaseLocation = path.toNamespacedPath(fs.realpathSync(pathname));
  const opened = new Set<DatabaseSync>();
  const historicalReads: string[] = [];
  const historicalColumns = new Set(columns);
  const spy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    const location = database.location();
    if (location !== null && path.toNamespacedPath(location) === databaseLocation) {
      opened.add(database);
      database.setAuthorizer((action, table, column) => {
        const field = `${table}.${column}`;
        if (action === constants.SQLITE_READ && historicalColumns.has(field)) {
          historicalReads.push(field);
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
    }
    return database;
  });
  try {
    const result = await operation();
    expect(opened.size).toBeGreaterThan(0);
    expect(historicalReads).toEqual([]);
    return result;
  } finally {
    spy.mockRestore();
    for (const database of opened) {
      if (database.isOpen) {
        database.setAuthorizer(null);
      }
    }
  }
}

describe("ACP replay accounting repair", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("reuses completed accounting repair and repairs newly restored legacy columns", async () => {
    const replay = replayFixture();
    closeOpenClawStateDatabaseForTest();
    replay.repair();
    closeOpenClawStateDatabaseForTest();
    const repeated = await replay.historicalReadGuard(
      () => repairOpenClawStateDatabaseSchema(replay.options),
      ["acp_replay_events.update_json", "acp_replay_sessions.estimated_bytes"],
    );
    expect(repeated.warnings).toEqual([]);
    {
      using legacy = new DatabaseSync(replay.options.path);
      legacy.exec(dropAccounting);
    }
    replay.assertRepaired();
  });

  it.each(["runtime", "automatic"])(
    "populates newly added accounting columns through %s without changing canonical rows",
    async (entrance) => {
      const replay = replayFixture();
      replay.initial.exec(dropAccounting);
      closeOpenClawStateDatabaseForTest();
      if (entrance === "automatic") {
        expect((await prepareOpenClawStateDatabaseSchema(replay.options)).warnings).toEqual([]);
      }
      replay.assertRepaired();
      replay.assertRepaired(await replay.reopen());
    },
  );

  it.each(
    ["UTF-8", "UTF-16le"].flatMap((encoding) =>
      Object.entries(schemaChanges).flatMap(([schema, sql]) =>
        ["runtime", "automatic"].map((entrance) => ({ encoding, schema, sql, entrance })),
      ),
    ),
  )(
    "leaves $encoding replay repair to Doctor through $entrance with $schema schema",
    async ({ encoding, sql, entrance }) => {
      const replay = replayFixture(encoding);
      if (sql) {
        replay.initial.exec(sql);
      }
      closeOpenClawStateDatabaseForTest();
      if (entrance === "automatic") {
        const prepared = await replay.historicalReadGuard(() =>
          prepareOpenClawStateDatabaseSchema(replay.options),
        );
        expect(prepared.warnings).toEqual([]);
      } else {
        await replay.runtime();
        closeOpenClawStateDatabaseForTest();
      }
      {
        using inspected = new DatabaseSync(replay.options.path, { readOnly: true });
        replay.assertUnchanged(inspected);
      }
      replay.assertUnchanged(await replay.runtime());
      closeOpenClawStateDatabaseForTest();
      const repairedEstimates = estimates(replay.repair());
      expect(estimates(await replay.reopen())).toEqual(repairedEstimates);
    },
  );

  it("rolls back event repairs and the release checkpoint when a later session repair fails, then doctor retries atomically", async () => {
    const replay = replayFixture();
    replay.initial
      .exec(`CREATE TRIGGER reject_acp_session_repair BEFORE UPDATE OF estimated_bytes ON acp_replay_sessions
      BEGIN SELECT RAISE(ABORT, 'synthetic ACP repair failure'); END`);
    closeOpenClawStateDatabaseForTest();
    const failed = repairOpenClawStateDatabaseSchema(replay.options);
    expect(failed.warnings.join(" ")).toContain("synthetic ACP repair failure");
    {
      using inspect = new DatabaseSync(replay.options.path);
      expect(canonicalReplay(inspect)).toEqual(replay.before);
      expect(estimates(inspect)).toEqual(replay.oldEstimates);
      inspect.exec("DROP TRIGGER reject_acp_session_repair");
    }
    replay.repair();
  });
});
