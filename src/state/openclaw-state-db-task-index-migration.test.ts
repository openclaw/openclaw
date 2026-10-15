import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../cron/store/run-history.types.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

// Historical v22 definitions, independent of the migration's index inventory.
const legacyIndexes = [
  ["idx_task_runs_run_id", "run_id"],
  ["idx_task_runs_status", "status"],
  ["idx_task_runs_runtime_status", "runtime, status"],
  ["idx_task_runs_cleanup_after", "cleanup_after"],
  ["idx_task_runs_last_event_at", "last_event_at"],
  ["idx_task_runs_owner_key", "owner_key"],
  ["idx_task_runs_parent_flow_id", "parent_flow_id"],
  ["idx_task_runs_child_session_key", "child_session_key"],
  ["idx_task_runs_requester_session_key", "requester_session_key"],
  ["idx_task_runs_runtime_source_ended", "runtime, source_id, ended_at, created_at, task_id"],
  ["idx_task_runs_runtime_ended", "runtime, ended_at, created_at, task_id"],
] as const;

const replacementIndexes = [
  ["idx_task_runs_runtime_run", ["runtime", "run_id", "source_id", "created_at", "task_id"], 0],
  ["idx_task_runs_cron_runtime_order", ["runtime", "created_at", "task_id"], 1],
  ["idx_task_runs_cron_source_order", ["source_id", "created_at", "task_id"], 1],
] as const;

function retainedTaskState(db: EngineConnection) {
  return {
    tasks: db.prepare("SELECT rowid, * FROM task_runs ORDER BY rowid").all(),
    deliveries: db.prepare("SELECT * FROM task_delivery_state ORDER BY task_id").all(),
    localSchema: db
      .prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE name = 'idx_task_runs_local_label'`,
      )
      .all(),
  };
}

function taskIndexNames(db: EngineConnection) {
  return db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'index' AND tbl_name = 'task_runs' AND sql IS NOT NULL ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function legacyTaskDatabase(previousVersion: 22 | 23, refusePublication = false) {
  const stateDir = directories.make(`task-index-v${previousVersion}-`);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const pathname = resolveOpenClawStateSqlitePath(env);
  const options = { env, path: pathname };
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  for (const [name] of replacementIndexes) {
    db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  for (const [name, columns] of legacyIndexes) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON task_runs(${columns})`);
  }
  db.exec(`
    PRAGMA user_version = ${previousVersion};
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', ${previousVersion}, 1, 1);
    CREATE INDEX idx_task_runs_local_label ON task_runs(label);
  `);
  const insert = db.prepare(`INSERT INTO task_runs
    (rowid, task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
     notify_policy, source_id, run_id, created_at, started_at, ended_at, label,
     terminal_summary, detail_json)
    VALUES (?, ?, ?, 'fixture-owner', 'system', 'synthetic task', 'succeeded',
      'not_applicable', 'silent', 'legacy-job', ?, 100, 110, 120, ?, ?, ?)`);
  for (const [rowid, id, runtime] of [
    [7, "task-c", "cron"],
    [30, "task-a", "subagent"],
    [12, "task-b", "cron"],
  ] as const) {
    insert.run(
      rowid,
      id,
      runtime,
      `run-${id}`,
      `label-${id}`,
      `summary-${id}`,
      JSON.stringify({ synthetic: true, body: id === "task-c" ? "x".repeat(32 * 1024) : "small" }),
    );
  }
  db.exec(`INSERT INTO task_delivery_state
    (task_id, requester_origin_json, last_notified_event_at)
    VALUES ('task-c', '{"channel":"synthetic"}', 125)`);
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  return { options, pathname, retained: retainedTaskState(db) };
}

it.each([
  { owner: "runtime", previousVersion: 22 },
  { owner: "doctor", previousVersion: 22 },
  { owner: "runtime", previousVersion: 23 },
  { owner: "doctor", previousVersion: 23 },
] as const)(
  "migrates v$previousVersion task indexes through $owner without losing retained tasks or subsequent cron writes",
  async ({ owner, previousVersion }) => {
    const { options, retained } = legacyTaskDatabase(previousVersion);
    if (owner === "doctor") {
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    }
    const { db } = openOpenClawStateDatabase(options);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    expect(retainedTaskState(db)).toEqual(retained);
    expect(taskIndexNames(db)).toEqual(
      ["idx_task_runs_local_label", ...replacementIndexes.map(([name]) => name)].toSorted(),
    );
    for (const [name, columns, partial] of replacementIndexes) {
      expect(
        db
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(name)
          .map((row) => row.name),
      ).toEqual(columns);
      expect(
        db.prepare("SELECT partial FROM pragma_index_list('task_runs') WHERE name = ?").get(name),
      ).toEqual({ partial });
      if (partial) {
        expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name)?.sql).toMatch(
          /WHERE\s+runtime\s*=\s*'cron'\s*$/iu,
        );
      }
    }

    const storeKey = path.join(options.env.OPENCLAW_STATE_DIR, "cron", "jobs.json");
    const input: CronRunHistoryWrite = {
      storeKey,
      jobId: "new-job",
      runId: "new-run",
      startedAt: 200,
      endedAt: 210,
      status: "succeeded",
      summary: "first result",
      detail: { kind: "cron-run", storeKey, runId: "new-run", status: "ok" },
    };
    runOpenClawStateWriteTransaction(
      ({ db: writeDb }) => recordCronRunInDatabase(writeDb, input),
      options,
    );
    const first = readCronRunRecordsInDatabase(db, input.jobId, input.runId);
    expect(first).toEqual([
      expect.objectContaining({ runId: "new-run", endedAt: 210, summary: "first result" }),
    ]);
    runOpenClawStateWriteTransaction(
      ({ db: writeDb }) =>
        recordCronRunInDatabase(writeDb, { ...input, endedAt: 220, summary: "updated result" }),
      options,
    );
    const updated = readCronRunRecordsInDatabase(db, input.jobId, input.runId);
    expect(updated.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(updated).toEqual([expect.objectContaining({ endedAt: 220, summary: "updated result" })]);
    const schemaVersion = db.prepare("PRAGMA schema_version").get();
    await closeOpenClawStateDatabaseAsync();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("PRAGMA schema_version").get()).toEqual(schemaVersion);
    expect(readCronRunRecordsInDatabase(reopened, input.jobId, input.runId)).toEqual(updated);
  },
);

it("rolls back task index replacement when schema publication fails", async () => {
  const { options, pathname, retained } = legacyTaskDatabase(23, true);
  expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 23 });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: 23 });
  expect(retainedTaskState(db)).toEqual(retained);
  expect(taskIndexNames(db)).toEqual(
    ["idx_task_runs_local_label", ...legacyIndexes.map(([name]) => name)].toSorted(),
  );
});
