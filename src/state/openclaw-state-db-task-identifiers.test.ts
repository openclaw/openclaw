import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { upsertSubagentRunRowInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { readSubagentRun } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createStateSchemaMigrationStep } from "../infra/state-migrations.state-schema.js";
import { readTaskRecord } from "../tasks/task-registry.store.kernel.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";

function seedTask(db: DatabaseSync, taskId: string, runId: string, childSessionKey: string) {
  db.prepare(`INSERT INTO task_runs (
    task_id, runtime, owner_key, requester_session_key, scope_kind, task, status,
    delivery_status, notify_policy, created_at, run_id, child_session_key
  ) VALUES (?, 'subagent', 'agent:main:main', 'agent:main:main', 'session',
    'Preserve completion ownership', 'running', 'pending', 'silent', 100, ?, ?)`).run(
    taskId,
    runId,
    childSessionKey,
  );
  db.prepare(
    "INSERT INTO task_delivery_state (task_id, last_notified_event_at) VALUES (?, 90)",
  ).run(taskId);
}

function seedRun(database: OpenClawStateDatabase, privateCompletion: boolean) {
  const run: SubagentRunRecord = {
    runId: " \trun-one\n",
    childSessionKey: "\u00a0agent:main:subagent:one\u00a0",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Preserve completion ownership",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "terminal", endedAt: 200, outcome: { status: "ok" } },
    completion: { required: true, resultText: "result" },
    delivery: { status: "pending", attemptCount: 2, lastError: "retry later" },
    ...(privateCompletion ? { completionTarget: "parent" as const } : {}),
  };
  upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(run));
  return run;
}

function snapshot(db: DatabaseSync) {
  return {
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    delivery: db.prepare("SELECT * FROM task_delivery_state ORDER BY task_id").all(),
    subagents: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
  };
}

it.each([false, true])(
  "Doctor repairs task identifiers and the existing implicit completion link (private=%s)",
  async (privateCompletion) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const run = seedRun(database, privateCompletion);
      seedTask(database.db, "task-one", run.runId, run.childSessionKey);
      seedTask(database.db, "task-duplicate", run.runId, run.childSessionKey);
      seedTask(database.db, "task-empty", " \t\n", "\u00a0");
      const before = snapshot(database.db);
      const pathname = database.path;
      closeOpenClawStateDatabaseForTest();

      expect((await prepareOpenClawStateDatabaseSchema({ env: state.env })).warnings).toEqual([]);
      const unchanged = new DatabaseSync(pathname);
      expect(snapshot(unchanged)).toEqual(before);
      unchanged.close();

      const doctor = createStateSchemaMigrationStep({
        stateDir: state.stateDir,
        env: state.env,
        mode: "doctor",
        requiredness: "required",
      });
      expect((await doctor.run()).warnings).toEqual([]);
      const repaired = openOpenClawStateDatabase({ env: state.env });
      try {
        const task = readTaskRecord(repaired.db, "task-one");
        expect(task).toMatchObject({
          runId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
        expect(readTaskRecord(repaired.db, "task-duplicate")).toMatchObject({
          runId: task?.runId,
          childSessionKey: task?.childSessionKey,
        });
        expect(readTaskRecord(repaired.db, "task-empty")?.runId).toBeUndefined();
        expect(readTaskRecord(repaired.db, "task-empty")?.childSessionKey).toBeUndefined();
        expect(readSubagentRun(repaired, run.runId)).toEqual({
          ...run,
          taskRunId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
        expect(snapshot(repaired.db).delivery).toEqual(before.delivery);
        const after = snapshot(repaired.db);
        closeOpenClawStateDatabaseForTest();
        expect((await doctor.run()).warnings).toEqual([]);
        const repeated = new DatabaseSync(pathname);
        try {
          expect(snapshot(repeated)).toEqual(after);
        } finally {
          repeated.close();
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
);

it.each(["task", "completion", "padded completion"])(
  "Doctor refuses a distinct %s run identity collision without changing any task state",
  async (conflict) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const run = seedRun(database, false);
      seedTask(database.db, "task-one", run.runId, run.childSessionKey);
      if (conflict === "task") {
        seedTask(database.db, "task-conflict", "run-one", "agent:main:subagent:other");
      } else {
        upsertSubagentRunRowInDatabase(
          database,
          bindSubagentRunRecord({
            ...run,
            runId: "unrelated-physical-run",
            taskRunId: "run-one",
          }),
        );
        if (conflict === "padded completion") {
          database.db
            .prepare(
              "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.taskRunId', ?) WHERE run_id = ?",
            )
            .run(run.runId, "unrelated-physical-run");
        }
        // The reader normalizes explicit links before comparing them with a task's run ID.
        expect(readSubagentRun(database, "unrelated-physical-run")?.taskRunId).toBe("run-one");
        expect(readTaskRecord(database.db, "task-one")?.runId).toBe(run.runId);
      }
      const before = snapshot(database.db);
      const pathname = database.path;
      closeOpenClawStateDatabaseForTest();
      const result = await createStateSchemaMigrationStep({
        stateDir: state.stateDir,
        env: state.env,
        mode: "doctor",
        requiredness: "required",
      }).run();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining("task run identifier")]);
      const preserved = new DatabaseSync(pathname);
      try {
        expect(snapshot(preserved)).toEqual(before);
      } finally {
        preserved.close();
      }
    });
  },
);

it.each([false, true])(
  "repairs a child key without rebinding a physical run (task canonical=%s)",
  async (taskCanonical) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const run = seedRun(database, false);
      seedTask(
        database.db,
        "task-one",
        "run-one",
        taskCanonical ? run.childSessionKey.trim() : run.childSessionKey,
      );
      database.db
        .prepare(
          "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.delivery.payload.frozenResultText', 'legacy result') WHERE run_id = ?",
        )
        .run(run.runId);
      closeOpenClawStateDatabaseForTest();
      const result = await createStateSchemaMigrationStep({
        stateDir: state.stateDir,
        env: state.env,
        mode: "doctor",
        requiredness: "required",
      }).run();
      expect(result.warnings).toEqual([]);
      const repaired = openOpenClawStateDatabase({ env: state.env });
      try {
        const restored = readSubagentRun(repaired, run.runId);
        expect(restored?.runId).toBe(run.runId);
        expect(restored?.taskRunId).toBeUndefined();
        expect(restored?.childSessionKey).toBe("agent:main:subagent:one");
        expect(restored?.completion?.resultText).toBe("result");
        expect(readTaskRecord(repaired.db, "task-one")?.progressSummary).toBeUndefined();
        expect(readTaskRecord(repaired.db, "task-one")).toMatchObject({
          runId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
);
