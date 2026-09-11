import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { adoptReleasedSubagentTaskOwnership } from "../agents/subagents/registry/subagent-task-ownership.js";
import {
  finalizeSubagentTaskRunForOwner,
  getDetachedTaskLifecycleRuntime,
  setSubagentTaskDeliveryStatusForOwner,
} from "../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.test-support.js";
import { reloadTaskRegistryFromStore } from "../tasks/task-registry.js";
import { loadTaskRegistryStateFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { repairLegacySubagentTaskBindings } from "./openclaw-state-db-legacy-backfills.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});

// Exact affected tables from v2026.6.34:src/state/openclaw-state-schema.sql (schema v1).
// Its run-manager changed runId on steer but kept sessionStartedAt and the original task row.
const RELEASED_TABLES = `
  PRAGMA user_version = 1;
  CREATE TABLE task_runs (
    task_id TEXT NOT NULL PRIMARY KEY,
    runtime TEXT NOT NULL, task_kind TEXT, source_id TEXT,
    requester_session_key TEXT, owner_key TEXT NOT NULL, scope_kind TEXT NOT NULL,
    child_session_key TEXT, parent_flow_id TEXT, parent_task_id TEXT,
    agent_id TEXT, requester_agent_id TEXT, run_id TEXT, label TEXT,
    task TEXT NOT NULL, status TEXT NOT NULL, delivery_status TEXT NOT NULL,
    notify_policy TEXT NOT NULL, created_at INTEGER NOT NULL,
    started_at INTEGER, ended_at INTEGER, last_event_at INTEGER, cleanup_after INTEGER,
    error TEXT, progress_summary TEXT, terminal_summary TEXT, terminal_outcome TEXT
  );
  CREATE TABLE flow_runs (
    flow_id TEXT NOT NULL PRIMARY KEY,
    shape TEXT,
    sync_mode TEXT NOT NULL DEFAULT 'managed',
    owner_key TEXT NOT NULL,
    requester_origin_json TEXT,
    controller_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    notify_policy TEXT NOT NULL,
    goal TEXT NOT NULL,
    current_step TEXT,
    blocked_task_id TEXT,
    blocked_summary TEXT,
    state_json TEXT,
    wait_json TEXT,
    cancel_requested_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE subagent_runs (
    run_id TEXT NOT NULL PRIMARY KEY,
    child_session_key TEXT NOT NULL, controller_session_key TEXT,
    requester_session_key TEXT NOT NULL, requester_display_key TEXT NOT NULL,
    requester_origin_json TEXT, task TEXT NOT NULL, task_name TEXT, cleanup TEXT NOT NULL,
    label TEXT, model TEXT, agent_dir TEXT, workspace_dir TEXT,
    run_timeout_seconds INTEGER, spawn_mode TEXT, created_at INTEGER NOT NULL,
    started_at INTEGER, session_started_at INTEGER, accumulated_runtime_ms INTEGER,
    ended_at INTEGER, outcome_json TEXT, archive_at_ms INTEGER,
    cleanup_completed_at INTEGER, cleanup_handled INTEGER, suppress_announce_reason TEXT,
    expects_completion_message INTEGER, announce_retry_count INTEGER,
    last_announce_retry_at INTEGER, last_announce_delivery_error TEXT,
    ended_reason TEXT, pause_reason TEXT, wake_on_descendant_settle INTEGER,
    frozen_result_text TEXT, frozen_result_captured_at INTEGER,
    fallback_frozen_result_text TEXT, fallback_frozen_result_captured_at INTEGER,
    ended_hook_emitted_at INTEGER, pending_final_delivery INTEGER,
    pending_final_delivery_created_at INTEGER, pending_final_delivery_last_attempt_at INTEGER,
    pending_final_delivery_attempt_count INTEGER, pending_final_delivery_last_error TEXT,
    pending_final_delivery_payload_json TEXT, completion_announced_at INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
`;

function createReleasedDatabase(execution: "running" | "terminal") {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-released-subagent-binding-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(RELEASED_TABLES);
  const terminal = execution === "terminal";
  const payload = {
    runId: "replacement-run",
    childSessionKey: "agent:worker:subagent:legacy",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "retain the original task owner",
    cleanup: "keep",
    expectsCompletionMessage: true,
    createdAt: 200,
    startedAt: 200,
    sessionStartedAt: 100,
    ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    execution: {
      status: execution,
      startedAt: 200,
      ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    },
    completion: { required: true, ...(terminal ? { resultText: "retained result" } : {}) },
    delivery: terminal
      ? { status: "suspended", suspendedAt: 400, suspendedReason: "retry-limit" }
      : { status: "pending" },
  };
  db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, requester_session_key, owner_key, scope_kind,
      child_session_key, parent_flow_id, run_id, task, status, delivery_status, notify_policy,
      created_at, started_at, progress_summary
    ) VALUES (?, 'subagent', ?, ?, 'session', ?, 'original-flow', ?, ?, ?, ?, 'done_only', 100, 100, ?)
  `).run(
    "original-task",
    payload.requesterSessionKey,
    payload.requesterSessionKey,
    payload.childSessionKey,
    "original-run",
    payload.task,
    terminal ? "succeeded" : "running",
    terminal ? "failed" : "pending",
    terminal ? "retained result" : null,
  );
  db.prepare(`
    INSERT INTO flow_runs (
      flow_id, sync_mode, owner_key, status, notify_policy, goal, created_at, updated_at, ended_at
    ) VALUES ('original-flow', 'task_mirrored', ?, ?, 'done_only', ?, 100, ?, ?)
  `).run(
    payload.requesterSessionKey,
    terminal ? "succeeded" : "running",
    payload.task,
    terminal ? 300 : 200,
    terminal ? 300 : null,
  );
  db.prepare(`
    INSERT INTO subagent_runs (
      run_id, child_session_key, requester_session_key, requester_display_key,
      task, cleanup, created_at, started_at, session_started_at, ended_at,
      expects_completion_message, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, 200, 200, 100, ?, 1, ?)
  `).run(
    payload.runId,
    payload.childSessionKey,
    payload.requesterSessionKey,
    payload.requesterDisplayKey,
    payload.task,
    payload.cleanup,
    terminal ? 300 : null,
    JSON.stringify(payload),
  );
  return { db, databasePath };
}

function createV202671Database(params: {
  announcing: boolean;
  execution?: "running" | "terminal";
  generation?: number;
  linked?: boolean;
  notifyPolicy?: "done_only" | "state_changes" | "silent";
  releasedBacking?: boolean;
}) {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-v2026-7-1-subagent-binding-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(RELEASED_TABLES);
  const execution = params.execution ?? "running";
  const terminal = execution === "terminal";
  const runId = params.announcing ? "announcing-run" : "silent-run";
  const childSessionKey = `agent:worker:subagent:${params.announcing ? "announcing" : "silent"}`;
  const requesterSessionKey = "agent:main:main";
  const task = params.announcing ? "announce the result" : "collect the result";
  const flowId = (params.linked ?? params.announcing) ? "announcing-flow" : null;
  const notifyPolicy = params.notifyPolicy ?? (params.announcing ? "done_only" : "silent");
  const payload = {
    runId,
    taskRunId: runId,
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task,
    cleanup: "keep",
    expectsCompletionMessage: params.announcing,
    generation: params.generation ?? 7,
    createdAt: 100,
    startedAt: 100,
    sessionStartedAt: 100,
    ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    execution: {
      status: execution,
      startedAt: 100,
      ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    },
    completion: {
      required: params.announcing,
      ...(terminal ? { resultText: "released result" } : {}),
    },
    delivery: params.announcing
      ? terminal
        ? { status: "suspended", suspendedAt: 400, suspendedReason: "retry-limit" }
        : { status: "pending" }
      : { status: "not_required" },
  };
  db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, requester_session_key, owner_key, scope_kind,
      child_session_key, parent_flow_id, run_id, task, status, delivery_status,
      notify_policy, created_at, started_at, progress_summary
    ) VALUES (?, 'subagent', ?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, 100, 100, ?)
  `).run(
    `${runId}-task`,
    requesterSessionKey,
    requesterSessionKey,
    childSessionKey,
    flowId,
    runId,
    task,
    terminal ? "succeeded" : "running",
    params.announcing ? (terminal ? "failed" : "pending") : "not_applicable",
    notifyPolicy,
    terminal ? "released result" : null,
  );
  if (params.releasedBacking) {
    db.exec("ALTER TABLE task_runs ADD COLUMN detail_json TEXT");
    db.prepare("UPDATE task_runs SET source_id = ?, detail_json = ? WHERE run_id = ?").run(
      runId,
      JSON.stringify({
        kind: "task_backing_instance",
        runtime: "subagent",
        generation: params.generation ?? 7,
      }),
      runId,
    );
  }
  if (flowId) {
    db.prepare(`
      INSERT INTO flow_runs (
        flow_id, sync_mode, owner_key, status, notify_policy, goal,
        created_at, updated_at, ended_at
      ) VALUES (?, 'task_mirrored', ?, ?, ?, ?, 100, ?, ?)
    `).run(
      flowId,
      requesterSessionKey,
      terminal ? "succeeded" : "running",
      notifyPolicy,
      task,
      terminal ? 300 : 100,
      terminal ? 300 : null,
    );
  }
  db.prepare(`
    INSERT INTO subagent_runs (
      run_id, child_session_key, requester_session_key, requester_display_key,
      task, cleanup, created_at, started_at, session_started_at, ended_at,
      expects_completion_message, payload_json
    ) VALUES (?, ?, ?, 'main', ?, 'keep', 100, 100, 100, ?, ?, ?)
  `).run(
    runId,
    childSessionKey,
    requesterSessionKey,
    task,
    terminal ? 300 : null,
    params.announcing ? 1 : 0,
    JSON.stringify(payload),
  );
  return { db, runId, childSessionKey, requesterSessionKey, flowId };
}

function snapshot(db: DatabaseSync) {
  return {
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    runs: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
    flows: db.prepare("SELECT * FROM flow_runs ORDER BY flow_id").all(),
    version: db.prepare("PRAGMA user_version").get(),
  };
}

function withoutOwnershipClassification(value: ReturnType<typeof snapshot>) {
  return {
    ...value,
    runs: value.runs.map((row) => {
      const copy = { ...row } as { payload_json?: unknown };
      if (typeof copy.payload_json !== "string") {
        return copy;
      }
      try {
        const payload = JSON.parse(copy.payload_json) as Record<string, unknown>;
        delete payload.taskOwnershipPolicy;
        delete payload.legacyTaskOwnershipCandidate;
        copy.payload_json = JSON.stringify(payload);
      } catch {
        // Malformed released payloads remain byte-stable.
      }
      return copy;
    }),
  };
}

const ADD_TASK = `
  INSERT INTO task_runs (
    task_id, runtime, requester_session_key, owner_key, scope_kind, child_session_key,
    run_id, task, status, delivery_status, notify_policy, created_at
  ) SELECT 'second-task', runtime, requester_session_key, owner_key, scope_kind,
    child_session_key, 'second-original', task, status, delivery_status, notify_policy, 150
    FROM task_runs WHERE task_id = 'original-task';
`;
const ADD_RUN = `
  INSERT INTO subagent_runs (
    run_id, child_session_key, requester_session_key, requester_display_key,
    task, cleanup, created_at, payload_json
  ) SELECT 'second-run', child_session_key, requester_session_key, requester_display_key,
    task, cleanup, created_at, json_set(payload_json, '$.runId', 'second-run')
    FROM subagent_runs WHERE run_id = 'replacement-run';
`;

function readBindings(db: DatabaseSync) {
  return db
    .prepare(`
    SELECT run_id, json_type(payload_json, '$.taskRunId') AS binding_type,
      json_extract(payload_json, '$.taskRunId') AS binding
    FROM subagent_runs ORDER BY run_id
  `)
    .all();
}

describe("released subagent task bindings", () => {
  it("classifies an exact v2026.9.3 backing for runtime-checked adoption", () => {
    const fixture = createV202671Database({
      announcing: true,
      generation: 7,
      releasedBacking: true,
    });
    fixture.db.close();

    const upgraded = openOpenClawStateDatabase();
    expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: "core_required",
      taskRunId: fixture.runId,
      generation: 7,
    });
    const classified = snapshot(upgraded.db);
    closeOpenClawStateDatabaseForTest();

    const current = openOpenClawStateDatabase();
    expect(snapshot(current.db)).toEqual(classified);
    expect(repairLegacySubagentTaskBindings(current.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 1,
      backingMetadataSkipped: { ambiguous: 0, foreign: 0, mismatch: 0 },
    });
    expect(snapshot(current.db)).toEqual(classified);
    const run = loadSubagentRegistryFromSqlite().get(fixture.runId);
    if (!run) {
      throw new Error("classified released run was not restored");
    }
    resetTaskRegistryForTests({ persist: false });
    reloadTaskRegistryFromStore();
    expect(adoptReleasedSubagentTaskOwnership({}, run)).toBe(true);
    expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
      taskOwnershipPolicy: "core_required",
      legacyTaskOwnershipCandidate: undefined,
      requesterAgentId: "main",
    });
  });

  it.each([
    ["NULL", null],
    ["foreign", "other-run"],
    ["whitespace", "  announcing-run  "],
  ])("does not classify a released backing with %s source identity", (_label, sourceId) => {
    const fixture = createV202671Database({
      announcing: true,
      generation: 7,
      releasedBacking: true,
    });
    fixture.db.prepare("UPDATE task_runs SET source_id = ?").run(sourceId);

    repairLegacySubagentTaskBindings(fixture.db);

    expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: undefined,
    });
    fixture.db.close();
  });

  it("does not adopt an identical released tuple claimed by a custom runtime", () => {
    const fixture = createV202671Database({
      announcing: true,
      generation: 7,
      releasedBacking: true,
    });
    repairLegacySubagentTaskBindings(fixture.db);
    const run = loadSubagentRegistryFromSqlite().get(fixture.runId);
    if (!run) {
      throw new Error("classified custom released run was not restored");
    }
    resetTaskRegistryForTests({ persist: false });
    reloadTaskRegistryFromStore();
    setDetachedTaskLifecycleRuntime(getDetachedTaskLifecycleRuntime());

    expect(adoptReleasedSubagentTaskOwnership({}, run)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: "core_required",
    });
    fixture.db.close();
  });

  it.each(["core_required", "gateway_best_effort", "custom", "legacy_unresolved"] as const)(
    "preserves explicit %s ownership byte-for-byte",
    (taskOwnershipPolicy) => {
      const fixture = createV202671Database({
        announcing: true,
        generation: 7,
        releasedBacking: true,
      });
      fixture.db
        .prepare(`
        UPDATE subagent_runs
           SET payload_json = json_set(payload_json, '$.taskOwnershipPolicy', ?)
      `)
        .run(taskOwnershipPolicy);
      const before = snapshot(fixture.db);

      repairLegacySubagentTaskBindings(fixture.db);

      expect(snapshot(fixture.db)).toEqual(before);
      fixture.db.close();
    },
  );

  it("persists malformed ownership as unresolved without making it adoptable", () => {
    const fixture = createV202671Database({
      announcing: true,
      generation: 7,
      releasedBacking: true,
    });
    fixture.db.exec(`
      UPDATE subagent_runs
         SET payload_json = json_set(payload_json, '$.taskOwnershipPolicy', 'broken');
    `);

    repairLegacySubagentTaskBindings(fixture.db);

    expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: undefined,
    });
    fixture.db.close();
  });

  it.each([
    {
      label: "announcing mirrored done-only",
      announcing: true,
      linked: true,
      notifyPolicy: "done_only" as const,
      deliveryStatus: "delivered" as const,
    },
    {
      label: "announcing mirrored state-changes",
      announcing: true,
      linked: true,
      notifyPolicy: "state_changes" as const,
      deliveryStatus: "delivered" as const,
    },
    {
      label: "announcing mirrored silent",
      announcing: true,
      linked: true,
      notifyPolicy: "silent" as const,
      deliveryStatus: "delivered" as const,
    },
    {
      label: "announcing unlinked",
      announcing: true,
      linked: false,
      notifyPolicy: "state_changes" as const,
      deliveryStatus: "delivered" as const,
    },
    {
      label: "non-announcing unlinked",
      announcing: false,
      linked: false,
      notifyPolicy: "silent" as const,
      deliveryStatus: "not_applicable" as const,
    },
  ])(
    "repairs the actual v2026.7.1 $label producer shape and preserves its generation",
    ({ announcing, linked, notifyPolicy, deliveryStatus }) => {
      const fixture = createV202671Database({
        announcing,
        linked,
        notifyPolicy,
        generation: 7,
      });
      fixture.db.close();

      const upgraded = openOpenClawStateDatabase();
      const run = loadSubagentRegistryFromSqlite().get(fixture.runId);
      expect(run).toMatchObject({
        runId: fixture.runId,
        taskRunId: fixture.runId,
        generation: 7,
        expectsCompletionMessage: announcing,
      });
      expect(
        upgraded.db
          .prepare("SELECT detail_json FROM task_runs WHERE run_id = ?")
          .get(fixture.runId),
      ).toEqual({
        detail_json: '{"kind":"task_backing_instance","runtime":"subagent","generation":7}',
      });
      if (!run) {
        throw new Error("upgraded released run was not restored");
      }

      resetTaskRegistryForTests({ persist: false });
      reloadTaskRegistryFromStore();
      expect(
        finalizeSubagentTaskRunForOwner({
          runId: fixture.runId,
          ownerKey: fixture.requesterSessionKey,
          sessionKey: fixture.childSessionKey,
          generation: 7,
          status: "succeeded",
          endedAt: 500,
          lastEventAt: 500,
          progressSummary: "result after upgrade",
          terminalSummary: "result after upgrade",
          terminalOutcome: "succeeded",
        }).map((task) => task.taskId),
      ).toEqual([`${fixture.runId}-task`]);
      expect(
        setSubagentTaskDeliveryStatusForOwner({
          runId: fixture.runId,
          ownerKey: fixture.requesterSessionKey,
          sessionKey: fixture.childSessionKey,
          generation: 7,
          deliveryStatus,
        }).map((task) => task.taskId),
      ).toEqual([`${fixture.runId}-task`]);
      run.execution = { status: "terminal", endedAt: 500, outcome: { status: "ok" } };
      run.completion = { required: announcing, resultText: "result after upgrade" };
      run.delivery = announcing
        ? { status: "delivered", deliveredAt: 600 }
        : { status: "not_required" };
      saveSubagentRegistryChangesToSqlite(new Map([[run.runId, run]]), [run.runId]);

      closeOpenClawStateDatabaseForTest();
      resetTaskRegistryForTests({ persist: false });
      const reopened = openOpenClawStateDatabase();
      expect(
        reopened.db
          .prepare(
            `SELECT run_id, parent_flow_id, status, delivery_status, progress_summary,
                    terminal_summary, terminal_outcome, detail_json
               FROM task_runs WHERE task_id = ?`,
          )
          .get(`${fixture.runId}-task`),
      ).toEqual({
        run_id: fixture.runId,
        parent_flow_id: fixture.flowId,
        status: "succeeded",
        delivery_status: deliveryStatus,
        progress_summary: "result after upgrade",
        terminal_summary: "result after upgrade",
        terminal_outcome: "succeeded",
        detail_json: '{"kind":"task_backing_instance","runtime":"subagent","generation":7}',
      });
      expect(loadSubagentRegistryFromSqlite().get(fixture.runId)).toMatchObject({
        taskRunId: fixture.runId,
        generation: 7,
        execution: { status: "terminal" },
        delivery: { status: announcing ? "delivered" : "not_required" },
      });
      const firstReopen = snapshot(reopened.db);
      closeOpenClawStateDatabaseForTest();
      expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstReopen);
    },
  );

  it("leaves a mixed explicit and implicit task binding collision unchanged", () => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      UPDATE subagent_runs
         SET run_id = 'explicit-row',
             payload_json = json_set(payload_json, '$.runId', 'explicit-row');
      INSERT INTO subagent_runs (
        run_id, child_session_key, requester_session_key, requester_display_key,
        task, cleanup, created_at, started_at, session_started_at,
        expects_completion_message, payload_json
      ) SELECT 'announcing-run', 'agent:worker:subagent:collision',
               requester_session_key, requester_display_key, task, cleanup,
               created_at, started_at, session_started_at, 1,
               json_remove(json_set(
                 payload_json,
                 '$.runId', 'announcing-run',
                 '$.childSessionKey', 'agent:worker:subagent:collision'
               ), '$.taskRunId')
          FROM subagent_runs WHERE run_id = 'explicit-row';
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
    `);
    const before = snapshot(fixture.db);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 2, foreign: 0, mismatch: 0 },
    });
    expect(withoutOwnershipClassification(snapshot(fixture.db))).toEqual(before);
    fixture.db.close();
  });

  it.each([
    ["null", "NULL"],
    ["empty", "''"],
    ["number", "7"],
    ["object", "json('{}')"],
    ["array", "json('[]')"],
    ["boolean", "json('true')"],
  ])("reserves an aligned explicit %s binding as a competing claim", (_label, value) => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      UPDATE subagent_runs
         SET run_id = 'eligible-row',
             payload_json = json_set(payload_json, '$.runId', 'eligible-row');
      INSERT INTO subagent_runs (
        run_id, child_session_key, requester_session_key, requester_display_key,
        task, cleanup, created_at, started_at, session_started_at,
        expects_completion_message, payload_json
      ) SELECT 'announcing-run', child_session_key, requester_session_key,
               requester_display_key, task, cleanup, created_at, started_at,
               session_started_at, expects_completion_message,
               json_set(payload_json, '$.runId', 'announcing-run', '$.taskRunId', ${value})
          FROM subagent_runs WHERE run_id = 'eligible-row';
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
    `);
    const before = snapshot(fixture.db);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 1, foreign: 1, mismatch: 0 },
    });
    expect(withoutOwnershipClassification(snapshot(fixture.db))).toEqual(before);
    fixture.db.close();
  });

  it.each([
    ["malformed JSON", "'{'"],
    ["an array", "json('[]')"],
    ["a scalar", "json('7')"],
    ["JSON null", "json('null')"],
  ])("preserves a released run whose payload is %s", (_label, payload) => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
      UPDATE subagent_runs SET payload_json = ${payload};
    `);
    const before = snapshot(fixture.db);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 0, foreign: 1, mismatch: 0 },
    });
    expect(withoutOwnershipClassification(snapshot(fixture.db))).toEqual(before);
    fixture.db.close();
  });

  it("treats trimmed duplicate task run keys as ambiguous", () => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      INSERT INTO task_runs (
        task_id, runtime, requester_session_key, owner_key, scope_kind,
        child_session_key, run_id, task, status, delivery_status, notify_policy, created_at
      ) SELECT 'second-task', runtime, requester_session_key, owner_key, scope_kind,
        child_session_key, '  announcing-run  ', task, status, delivery_status,
        notify_policy, 150
        FROM task_runs WHERE task_id = 'announcing-run-task';
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
    `);
    const before = snapshot(fixture.db);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 1, foreign: 0, mismatch: 0 },
    });
    expect(withoutOwnershipClassification(snapshot(fixture.db))).toEqual(before);
    fixture.db.close();
  });

  it.each([
    ["null", "NULL"],
    ["blank", "'   '"],
  ])("preserves a released task with a %s run key", (_label, runId) => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
      UPDATE task_runs SET run_id = ${runId};
    `);
    const before = snapshot(fixture.db);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 0, foreign: 0, mismatch: 1 },
    });
    expect(withoutOwnershipClassification(snapshot(fixture.db))).toEqual(before);
    fixture.db.close();
  });

  it("accepts an exclusive implicit run-id binding without synthesizing task ownership", () => {
    const fixture = createV202671Database({ announcing: true, generation: 7 });
    fixture.db.exec(`
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
      UPDATE subagent_runs SET payload_json = json_remove(payload_json, '$.taskRunId');
    `);

    expect(repairLegacySubagentTaskBindings(fixture.db)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 1,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: { ambiguous: 0, foreign: 0, mismatch: 0 },
    });
    expect(
      fixture.db
        .prepare(
          `SELECT json_type(payload_json, '$.taskRunId') AS binding_type,
                  json_extract(payload_json, '$.generation') AS generation
             FROM subagent_runs`,
        )
        .get(),
    ).toEqual({ binding_type: null, generation: 7 });
    expect(fixture.db.prepare("SELECT detail_json FROM task_runs").get()).toEqual({
      detail_json: '{"kind":"task_backing_instance","runtime":"subagent","generation":7}',
    });
    fixture.db.close();
  });

  it.each(["terminal", "running"] as const)(
    "upgrades a %s v2026.6.34 replacement and retains its owner after reopen",
    (execution) => {
      const { db: released } = createReleasedDatabase(execution);
      expect(released.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      released.close();

      const upgraded = openOpenClawStateDatabase();
      const run = loadSubagentRegistryFromSqlite().get("replacement-run");
      expect(run).toMatchObject({
        runId: "replacement-run",
        taskRunId: "original-run",
        generation: 1,
        execution: { status: execution },
      });
      expect(
        upgraded.db
          .prepare("SELECT detail_json FROM task_runs WHERE task_id = 'original-task'")
          .get(),
      ).toEqual({
        detail_json: '{"kind":"task_backing_instance","runtime":"subagent","generation":1}',
      });
      expect(upgraded.db.prepare("PRAGMA table_info(subagent_runs)").all()).not.toContainEqual(
        expect.objectContaining({ name: "session_started_at" }),
      );

      if (execution === "running") {
        if (!run) {
          throw new Error("upgraded replacement was not restored");
        }
        resetTaskRegistryForTests({ persist: false });
        reloadTaskRegistryFromStore();
        expect(
          finalizeSubagentTaskRunForOwner({
            runId: "original-run",
            ownerKey: run.requesterSessionKey,
            sessionKey: run.childSessionKey,
            generation: run.generation,
            status: "succeeded",
            endedAt: 500,
            lastEventAt: 500,
            progressSummary: "result after upgrade",
            terminalSummary: "result after upgrade",
            terminalOutcome: "succeeded",
          }).map((task) => task.taskId),
        ).toEqual(["original-task"]);
        expect(
          setSubagentTaskDeliveryStatusForOwner({
            runId: "original-run",
            ownerKey: run.requesterSessionKey,
            sessionKey: run.childSessionKey,
            generation: run.generation,
            deliveryStatus: "delivered",
          }).map((task) => task.taskId),
        ).toEqual(["original-task"]);
        run.execution = { status: "terminal", endedAt: 500, outcome: { status: "ok" } };
        run.completion = { required: true, resultText: "result after upgrade" };
        run.delivery = { status: "delivered", deliveredAt: 600 };
        saveSubagentRegistryChangesToSqlite(new Map([[run.runId, run]]), [run.runId]);
        closeOpenClawStateDatabaseForTest();
        resetTaskRegistryForTests({ persist: false });
        reloadTaskRegistryFromStore();
        expect(loadTaskRegistryStateFromSqlite().tasks.get("original-task")).toMatchObject({
          runId: "original-run",
          status: "succeeded",
          deliveryStatus: "delivered",
          progressSummary: "result after upgrade",
          terminalSummary: "result after upgrade",
          terminalOutcome: "succeeded",
          detail: {
            kind: "task_backing_instance",
            runtime: "subagent",
            generation: 1,
          },
        });
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
          taskRunId: "original-run",
          generation: 1,
          execution: { status: "terminal" },
          completion: { resultText: "result after upgrade" },
          delivery: { status: "delivered" },
        });
      }
      const firstOpen = snapshot(openOpenClawStateDatabase().db);
      closeOpenClawStateDatabaseForTest();
      expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);
    },
  );

  it.each([
    ["another child task", ADD_TASK],
    [
      "another child run already delivered",
      `${ADD_RUN}
      UPDATE subagent_runs SET payload_json = json_set(payload_json,
        '$.delivery.status', 'delivered') WHERE run_id = 'second-run';`,
    ],
    [
      "a task run collision in another child",
      `${ADD_TASK}
      UPDATE task_runs SET child_session_key = 'another-child', run_id = 'original-run'
        WHERE task_id = 'second-task';`,
    ],
    [
      "a remapped run collision in another child",
      `${ADD_RUN}
      UPDATE subagent_runs SET child_session_key = 'another-child',
        payload_json = json_set(payload_json, '$.taskRunId', 'original-run')
        WHERE run_id = 'second-run';`,
    ],
    [
      "an unmapped run collision in another child",
      `${ADD_RUN}
      UPDATE subagent_runs SET child_session_key = 'another-child', run_id = 'original-run'
        WHERE run_id = 'second-run';`,
    ],
    ["a managed flow", "UPDATE flow_runs SET sync_mode = 'managed';"],
    ["a missing flow", "UPDATE task_runs SET parent_flow_id = 'missing-flow';"],
    ["a different requester", "UPDATE task_runs SET requester_session_key = 'another-requester';"],
    ["a task before the session", "UPDATE task_runs SET created_at = 99;"],
    ["a task after the replacement", "UPDATE task_runs SET created_at = 201;"],
    [
      "no earlier session start",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.sessionStartedAt', 200);`,
    ],
    [
      "an explicit canonical binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', 'original-run');`,
    ],
    [
      "an explicit unmatched binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', 'unknown-run');`,
    ],
    [
      "an explicit null binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', NULL);`,
    ],
  ])("preserves ownership with %s", (_label, change) => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec(change);
    const before = readBindings(released);
    released.close();

    const upgraded = openOpenClawStateDatabase();
    expect(readBindings(upgraded.db)).toEqual(before);
    const firstOpen = snapshot(upgraded.db);
    closeOpenClawStateDatabaseForTest();
    expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);
  });

  it("binds before projecting the result held only in the released pending payload", () => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec(`
      UPDATE task_runs SET progress_summary = NULL;
      UPDATE subagent_runs SET
        payload_json = json_remove(payload_json, '$.completion.resultText'),
        pending_final_delivery_payload_json = '{"frozenResultText":"only retained result"}';
    `);
    released.close();

    const upgraded = openOpenClawStateDatabase();
    expect(upgraded.db.prepare("SELECT run_id, progress_summary FROM task_runs").all()).toEqual([
      { run_id: "original-run", progress_summary: "only retained result" },
    ]);
    expect(loadSubagentRegistryFromSqlite().get("replacement-run")).toMatchObject({
      taskRunId: "original-run",
      completion: { resultText: "only retained result" },
    });
    const firstOpen = snapshot(upgraded.db);
    closeOpenClawStateDatabaseForTest();
    expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);
  });

  it("rolls back every binding and earlier repair when one binding write fails", () => {
    const { db: released, databasePath } = createReleasedDatabase("terminal");
    released.exec(`${ADD_TASK}${ADD_RUN}
      UPDATE task_runs SET child_session_key = 'another-child' WHERE task_id = 'second-task';
      UPDATE subagent_runs SET child_session_key = 'another-child' WHERE run_id = 'second-run';
      INSERT INTO flow_runs (
        flow_id, sync_mode, owner_key, status, notify_policy, goal, created_at, updated_at, ended_at
      ) SELECT 'second-flow', sync_mode, owner_key, status, notify_policy,
               goal, created_at, updated_at, ended_at
          FROM flow_runs WHERE flow_id = 'original-flow';
      UPDATE task_runs SET parent_flow_id = 'second-flow' WHERE task_id = 'second-task';
      CREATE TRIGGER reject_second_binding BEFORE UPDATE OF payload_json ON subagent_runs
        WHEN OLD.run_id = 'second-run' AND json_type(NEW.payload_json, '$.taskRunId') = 'text'
      BEGIN
        SELECT RAISE(ABORT, 'binding write refused');
      END;
    `);
    const before = snapshot(released);
    released.close();

    expect(() => openOpenClawStateDatabase()).toThrow("binding write refused");
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(snapshot(preserved)).toEqual(before);
    } finally {
      preserved.close();
    }
  });

  it.each([
    {
      label: "an ambiguous task binding",
      change: `${ADD_TASK}
        UPDATE task_runs SET run_id = 'original-run' WHERE task_id = 'second-task';
        UPDATE subagent_runs SET payload_json = json_set(
          payload_json, '$.taskRunId', 'original-run'
        );`,
      skipped: { ambiguous: 1, foreign: 0, mismatch: 0 },
    },
    {
      label: "foreign generation metadata",
      change: `UPDATE subagent_runs SET payload_json = json_set(
        payload_json, '$.taskRunId', 'original-run', '$.generation', 0
      );`,
      skipped: { ambiguous: 0, foreign: 1, mismatch: 0 },
    },
    {
      label: "mismatched generations",
      change: `UPDATE subagent_runs SET payload_json = json_set(
          payload_json, '$.taskRunId', 'original-run', '$.generation', 2
        );
        UPDATE task_runs SET detail_json =
          '{"kind":"task_backing_instance","runtime":"subagent","generation":1}';`,
      skipped: { ambiguous: 0, foreign: 0, mismatch: 1 },
    },
  ])("reports and preserves $label", ({ change, skipped }) => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec("ALTER TABLE task_runs ADD COLUMN detail_json TEXT");
    released.exec(change);
    const before = snapshot(released);

    expect(repairLegacySubagentTaskBindings(released)).toEqual({
      taskRunIdsRepaired: 0,
      backingMetadataRepaired: 0,
      backingMetadataUnchanged: 0,
      backingMetadataSkipped: skipped,
    });
    expect(withoutOwnershipClassification(snapshot(released))).toEqual(before);
    released.close();
  });

  it("rolls back generation when the matching task detail write fails", () => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec(`
      ALTER TABLE task_runs ADD COLUMN detail_json TEXT;
      UPDATE subagent_runs SET payload_json = json_set(
        payload_json, '$.taskRunId', 'original-run'
      );
      CREATE TRIGGER reject_backing_detail BEFORE UPDATE OF detail_json ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'backing detail write refused');
      END;
    `);
    const before = snapshot(released);

    expect(() => repairLegacySubagentTaskBindings(released)).toThrow(
      "backing detail write refused",
    );
    expect(snapshot(released)).toEqual(before);
    released.close();
  });
});
