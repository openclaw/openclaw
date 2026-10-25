import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { expectAcpReplayUtf8Accounting } from "../acp/event-ledger.test-support.js";
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
  const id = "session-0-漢\0\ud800";
  session.run(id, "key😀", "/é/e\u0301/台\0😀", 0);
  event.run(id, 1, "key😀\0", null, update, 0);
  event.run(id, 2, "key😀\0", "run-\udc00", update, 0);
  // Even already-correct event estimates must contribute to a repaired aggregate.
  event.run(id, 3, "ascii", null, "{}", 56);
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
const schemaChanges = `
  ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
  ALTER TABLE worktrees DROP COLUMN provisioned_paths_json;
  ALTER TABLE sandbox_registry_entries DROP COLUMN image;
  ALTER TABLE cron_jobs DROP COLUMN description;
  DROP INDEX idx_plugin_state_listing;
    CREATE INDEX idx_plugin_state_listing
      ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);`;

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
  return {
    options,
    initial,
    before,
    oldEstimates,
    assertRepaired,
    runtime: open,
    repair() {
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      return assertRepaired();
    },
    async reopen() {
      closeOpenClawStateDatabaseForTest();
      const db = open();
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

describe("ACP replay accounting repair", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("reuses completed accounting repair and repairs newly restored legacy columns", async () => {
    const replay = replayFixture();
    closeOpenClawStateDatabaseForTest();
    replay.repair();
    closeOpenClawStateDatabaseForTest();
    replay.repair();
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

  it.each([
    ["UTF-8", "runtime", false],
    ["UTF-16le", "automatic", false],
    ["UTF-16le", "runtime", true],
    ["UTF-8", "automatic", true],
  ] as const)(
    "leaves %s replay repair to Doctor through %s (schema repair: %s)",
    async (encoding, entrance, repair) => {
      const replay = replayFixture(encoding);
      if (repair) {
        replay.initial.exec(schemaChanges);
      }
      closeOpenClawStateDatabaseForTest();
      if (entrance === "automatic") {
        const prepared = await prepareOpenClawStateDatabaseSchema(replay.options);
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
