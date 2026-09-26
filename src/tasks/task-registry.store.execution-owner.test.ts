import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  readTaskRecord,
  readTaskRegistrySnapshotIfReady,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";
import type { TaskRecord } from "./task-registry.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

const task: TaskRecord = {
  taskId: "childless-task",
  runtime: "subagent",
  requesterSessionKey: "agent:main:fixture",
  ownerKey: "agent:main:fixture",
  scopeKind: "session",
  runId: "fixture-run",
  task: "Synthetic background work",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: 100,
  startedAt: 100,
  executionOwner: { host: "fixture-host", pid: 123, startIdentity: 456 },
};

function removeExecutionOwnership(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(task_runs)").all();
  for (const column of columns) {
    if (
      column.name === "execution_owner_host" ||
      column.name === "execution_owner_pid" ||
      column.name === "execution_owner_start_identity"
    ) {
      db.exec(`ALTER TABLE task_runs DROP COLUMN ${column.name}`);
    }
  }
}

it("records ownership on first task write and reopens safely for candidate and older readers", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("task-owner-reopen-") } };
  const initial = openOpenClawStateDatabase(options);
  const databasePath = initial.path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  let legacyTaskSchema: string;
  try {
    removeExecutionOwnership(legacy);
    const schema = legacy
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'task_runs'")
      .get()?.sql;
    if (typeof schema !== "string") {
      throw new Error("Missing fixture task schema");
    }
    legacyTaskSchema = schema;
    legacy
      .prepare(`
      INSERT INTO task_runs (
        task_id, runtime, requester_session_key, owner_key, scope_kind, task, status,
        delivery_status, notify_policy, created_at
      ) VALUES (?, 'subagent', 'agent:main:fixture', 'agent:main:fixture', 'session',
        'Legacy background work', 'running', 'pending', 'done_only', 100)
    `)
      .run(task.taskId);
  } finally {
    legacy.close();
  }

  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  const originalVersion = readOnly.prepare("PRAGMA user_version").get();
  try {
    const schemaCookie = readOnly.prepare("PRAGMA schema_version").get();
    const snapshot = readTaskRegistrySnapshotIfReady({ db: readOnly, path: databasePath });
    expect([...snapshot.tasks.keys()]).toEqual([task.taskId]);
    expect(snapshot.tasks.get(task.taskId)?.executionOwner).toBeUndefined();
    expect(readOnly.prepare("PRAGMA schema_version").get()).toEqual(schemaCookie);
  } finally {
    readOnly.close();
  }

  const candidate = openOpenClawStateDatabase(options);
  expect(
    candidate.db
      .prepare(
        "SELECT name FROM pragma_table_info('task_runs') WHERE name LIKE 'execution_owner_%'",
      )
      .all(),
  ).toEqual([]);
  const write = () =>
    runOpenClawStateWriteTransaction(
      (database) => upsertTaskWithDeliveryStateInDatabase(database, { task }),
      options,
    );
  expect(readTaskRecord(candidate.db, task.taskId)?.executionOwner).toBeUndefined();
  write();
  expect(readTaskRecord(candidate.db, task.taskId)?.executionOwner).toEqual(task.executionOwner);
  const schemaCookie = candidate.db.prepare("PRAGMA schema_version").get();
  write();
  expect(candidate.db.prepare("PRAGMA schema_version").get()).toEqual(schemaCookie);
  expect(candidate.db.prepare("PRAGMA user_version").get()).toEqual(originalVersion);
  expect(
    candidate.db
      .prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('task_runs')
        WHERE name LIKE 'execution_owner_%' ORDER BY name`)
      .all(),
  ).toEqual([
    { name: "execution_owner_host", type: "TEXT", notnull: 0, dflt_value: null },
    { name: "execution_owner_pid", type: "INTEGER", notnull: 0, dflt_value: null },
    { name: "execution_owner_start_identity", type: "INTEGER", notnull: 0, dflt_value: null },
  ]);
  closeOpenClawStateDatabaseForTest();

  const olderReader = new DatabaseSync(databasePath);
  try {
    assertSqliteSchemaContains(olderReader, "older task reader", legacyTaskSchema, {
      allowCompatibleAdditiveColumns: true,
    });
    expect(olderReader.prepare("SELECT task_id, status FROM task_runs").all()).toEqual([
      { task_id: task.taskId, status: "running" },
    ]);
    olderReader
      .prepare("UPDATE task_runs SET progress_summary = ? WHERE task_id = ?")
      .run("Older writer progress", task.taskId);
  } finally {
    olderReader.close();
  }

  const reopened = openOpenClawStateDatabase(options);
  expect(readTaskRecord(reopened.db, task.taskId)).toMatchObject({
    executionOwner: task.executionOwner,
    progressSummary: "Older writer progress",
  });
  expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(originalVersion);
});

it("retries rolled-back first-use DDL and treats partial or invalid ownership as unknown", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    removeExecutionOwnership(db);
    const write = () => upsertTaskWithDeliveryStateInDatabase({ db }, { task });
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        write();
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    expect(readTaskRecord(db, task.taskId)).toBeUndefined();
    write();
    expect(readTaskRecord(db, task.taskId)?.executionOwner).toEqual(task.executionOwner);
    for (const [host, pid, startIdentity] of [
      [null, 123, 456],
      ["fixture-host", null, 456],
      ["fixture-host", 123, null],
      ["", 123, 456],
      ["fixture-host", 0, 456],
      ["fixture-host", 123, -1],
    ] as const) {
      db.prepare(`UPDATE task_runs SET execution_owner_host = ?, execution_owner_pid = ?,
        execution_owner_start_identity = ? WHERE task_id = ?`).run(
        host,
        pid,
        startIdentity,
        task.taskId,
      );
      expect(readTaskRecord(db, task.taskId)?.executionOwner).toBeUndefined();
    }
  } finally {
    db.close();
  }
});
