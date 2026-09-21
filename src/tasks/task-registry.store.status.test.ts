import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { afterEach, beforeEach, expect, it } from "vitest";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { summarizeFullTaskInspection } from "./task-registry.audit.test-support.js";
import {
  bindTaskRecord,
  listTaskRecordsByRuntimeSourceIdInDatabase,
  readTaskRegistrySnapshot,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";
import { readTaskRegistryStatusSnapshot } from "./task-registry.store.status.js";
import { addTaskStatusSummaryRecord } from "./task-registry.summary.js";
import {
  TASK_RUNTIMES,
  type JsonValue,
  type TaskRecord,
  type TaskStatus,
} from "./task-registry.types.js";

const now = 1_800_000_000_000;
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  enableNodeSqliteKyselyStatementCache(db);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
});
afterEach(() => db.close());

function store(taskId: string, overrides: Partial<TaskRecord> = {}): void {
  upsertTaskRunRowInDatabase(
    { db },
    bindTaskRecord({
      taskId,
      runtime: "cli",
      status: "succeeded",
      ownerKey: "agent:main:status",
      requesterSessionKey: "agent:main:status",
      scopeKind: "session",
      task: "Synthetic task",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: now - 60 * 60_000,
      ...overrides,
    }),
  );
}

function snapshot() {
  return readTaskRegistryStatusSnapshot({ db, path: ":memory:" }, now);
}

it("preserves the full-read counters and audits while bounding retained-history payloads", () => {
  const statuses: TaskStatus[] = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
  ];
  for (const runtime of TASK_RUNTIMES) {
    for (const status of statuses) {
      store(`${runtime}-${status}`, {
        runtime,
        status,
        deliveryStatus: "failed",
        notifyPolicy: status === "lost" ? "silent" : "done_only",
        ...(status === "lost" ? { cleanupAfter: now + 10_000 } : {}),
      });
    }
  }
  const payload = "retained-payload-".repeat(64 * 1024);
  store("large-history", { task: payload, detail: { payload }, terminalSummary: payload });
  store("malformed-history", { runtime: "subagent", detail: { unused: true } });
  db.prepare("UPDATE task_runs SET detail_json = '{' WHERE task_id = ?").run("malformed-history");
  const records = [...readTaskRegistrySnapshot({ db, path: ":memory:" }).tasks.values()];
  const expected = summarizeFullTaskInspection(records, now);

  const result = snapshot();
  expect(result.candidates).toHaveLength(8);
  expect(result.cronRecoveryRows.size).toBe(0);
  expect(serialize(result).byteLength).toBeLessThan(8_000);
  for (const candidate of result.candidates) {
    addTaskStatusSummaryRecord(result.summary, candidate, now);
  }
  expect(result.summary).toEqual(expected);
});

it("projects only exact subagent backing identities and ignores malformed or unrelated details", () => {
  const marker = { kind: "task_backing_instance", runtime: "subagent", generation: 1 };
  const details: JsonValue[] = [
    marker,
    { ...marker, generation: Number.MAX_SAFE_INTEGER },
    { ...marker, generation: 0 },
    { ...marker, generation: -1 },
    { ...marker, generation: 1.5 },
    { ...marker, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...marker, generation: "1" },
    { ...marker, generation: true },
    { ...marker, kind: "other" },
    { ...marker, runtime: "acp", instanceId: "other" },
    { ...marker, kind: { payload: "unused".repeat(64 * 1024) } },
    [marker],
    null,
  ];
  for (const [index, detail] of details.entries()) {
    store(`marker-${index}`, { runtime: "subagent", status: "running", detail });
  }
  store("malformed-marker", { runtime: "subagent", status: "running" });
  db.prepare("UPDATE task_runs SET detail_json = '{' WHERE task_id = ?").run("malformed-marker");
  store("real-marker", { runtime: "subagent", status: "running" });
  db.prepare("UPDATE task_runs SET detail_json = ? WHERE task_id = ?").run(
    '{"kind":"task_backing_instance","runtime":"subagent","generation":1.0}',
    "real-marker",
  );
  const result = snapshot();
  for (const candidate of result.candidates) {
    const input =
      candidate.taskId === "real-marker"
        ? marker
        : details[Number(candidate.taskId.slice("marker-".length))];
    const backing = readTaskBackingInstance(input);
    expect(readTaskBackingInstance(candidate.detail)).toEqual(
      backing?.runtime === "subagent" ? backing : undefined,
    );
  }
  expect(serialize(result).byteLength).toBeLessThan(8_000);
});

it.each(["runtime", "status", "delivery_status", "notify_policy"] as const)(
  "rejects invalid persisted summary input %s",
  (field) => {
    store("invalid-input");
    db.exec(`UPDATE task_runs SET ${field} = 'invalid' WHERE task_id = 'invalid-input'`);
    expect(snapshot).toThrow(/Invalid persisted task/u);
  },
);

it("keeps the first cron match in raw SQLite order with exact persisted run IDs", () => {
  const cron = (
    taskId: string,
    sourceId: string,
    runId: string | undefined,
    status: TaskStatus,
    createdAt: number,
  ) => {
    store(taskId, { runtime: "cron", sourceId, runId, status, createdAt });
  };
  cron("blocked-first", "blocked", "shared", "queued", 10);
  cron("blocked-terminal", "blocked", "shared", "succeeded", 20);
  cron("blocked-target", "blocked", "shared", "running", 30);
  cron("raw-first", "raw", "shared", "failed", 20);
  cron("normalized-first", "raw", "shared", "succeeded", 50);
  db.prepare("UPDATE task_runs SET started_at = 5, ended_at = 10 WHERE task_id = ?").run(
    "normalized-first",
  );
  cron("raw-target", "raw", "shared", "running", 100);
  cron("tie-\u{10000}", "tie", "shared", "succeeded", 10);
  cron("tie-\ue000", "tie", "shared", "failed", 10);
  cron("tie-target", "tie", "shared", "running", 30);
  cron("trimmed-run", "whitespace", "run", "failed", 10);
  cron("different-run", "whitespace", "different-run", "succeeded", 0);
  cron("exact-run", "whitespace", "run", "succeeded", 20);
  cron("whitespace-target", " whitespace ", "run", "running", 30);
  cron("blank-target", " missing ", undefined, "queued", 30);
  cron("blank-unrelated", "missing", undefined, "succeeded", 10);
  cron("legacy-target", "legacy", "run", "running", 30);
  cron("legacy-canonical", "legacy", "run", "succeeded", 10);
  cron("lost-target", "lost", "same", "lost", 30);
  db.prepare("UPDATE task_runs SET error = ? WHERE task_id = ?").run(
    "Prior BACKING SESSION MISSING",
    "lost-target",
  );
  cron("lost-recovered", "lost", "same", "succeeded", 10);
  store("other-runtime", { runtime: "cli", sourceId: "raw", runId: "shared", createdAt: 0 });
  // Only Doctor may repair persisted identities and their cross-row bindings.
  db.prepare("UPDATE task_runs SET run_id = ?, child_session_key = ? WHERE task_id = ?").run(
    "\t run \u00a0",
    " legacy-child ",
    "legacy-target",
  );
  const before = db.prepare("SELECT * FROM task_runs ORDER BY task_id").all();

  const result = snapshot();
  expect(result.candidates.find((row) => row.taskId === "legacy-target")).toMatchObject({
    runId: "\t run \u00a0",
    childSessionKey: " legacy-child ",
  });
  expect(db.prepare("SELECT * FROM task_runs ORDER BY task_id").all()).toEqual(before);
  for (const candidate of result.candidates) {
    const sourceId = candidate.sourceId?.trim();
    if (candidate.runtime !== "cron" || !sourceId) {
      continue;
    }
    const expected = listTaskRecordsByRuntimeSourceIdInDatabase(db, "cron", sourceId).find(
      (row) =>
        row.taskId === candidate.taskId ||
        (Boolean(candidate.runId?.trim()) && row.runId === candidate.runId),
    );
    const actual = result.cronRecoveryRows.get(candidate.taskId);
    expect(actual?.taskId).toBe(expected?.taskId);
    if (expected) {
      expect(actual).toMatchObject({
        status: expected.status,
        createdAt: expected.createdAt,
        ...(expected.endedAt !== undefined ? { endedAt: expected.endedAt } : {}),
        ...(expected.lastEventAt !== undefined ? { lastEventAt: expected.lastEventAt } : {}),
      });
      expect(actual).not.toHaveProperty("detail");
      expect(actual).not.toHaveProperty("error");
      expect(actual).not.toHaveProperty("terminalSummary");
    }
  }
  expect(result.cronRecoveryRows.get("blocked-target")?.status).toBe("queued");
  expect(result.cronRecoveryRows.get("raw-target")?.taskId).toBe("raw-first");
  expect(result.cronRecoveryRows.get("tie-target")?.taskId).toBe("tie-\ue000");
  expect(result.cronRecoveryRows.get("whitespace-target")?.taskId).toBe("trimmed-run");
  expect(result.cronRecoveryRows.get("legacy-target")?.taskId).toBe("legacy-target");
  expect(result.cronRecoveryRows.has("blank-target")).toBe(false);
  expect(result.cronRecoveryRows.get("lost-target")?.status).toBe("succeeded");
});

it("does not let a stale secondary index hide active tasks or retained counts", () => {
  store("active", { status: "running" });
  store("history", { status: "failed" });
  const expected = snapshot();
  db.exec(
    "DROP INDEX idx_task_runs_status; CREATE INDEX idx_task_runs_status ON task_runs(runtime)",
  );
  db.enableDefensive?.(false);
  db.exec("PRAGMA writable_schema = ON");
  db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_task_runs_status'").run(
    "CREATE INDEX idx_task_runs_status ON task_runs(status)",
  );
  const version = readSqliteNumberPragma(db, "schema_version");
  db.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${version + 1}`);
  expect(
    db
      .prepare(
        "SELECT task_id FROM task_runs INDEXED BY idx_task_runs_status WHERE status = 'running'",
      )
      .all(),
  ).toEqual([]);
  expect(() => readTaskRegistrySnapshot({ db, path: ":memory:" })).toThrow(
    /integrity_check failed/u,
  );
  expect(snapshot()).toEqual(expected);
});

it.each(["task table", "delivery table", "additive column"])(
  "reports missing %s without creating or repairing schema",
  (missing) => {
    db.exec(
      missing === "task table"
        ? "DROP TABLE task_runs"
        : missing === "delivery table"
          ? "DROP TABLE task_delivery_state"
          : "ALTER TABLE task_runs DROP COLUMN tool_use_count",
    );
    const schema = () =>
      db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
    const before = schema();
    const result = snapshot();
    expect(result.state).toBe("migration-required");
    expect(result.summary.tasks.total).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.cronRecoveryRows.size).toBe(0);
    expect(schema()).toEqual(before);
  },
);
