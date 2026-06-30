import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
  openDurableWorkflowSqliteStore,
} from "./sqlite-store.js";

const DURABLE_WORKFLOW_TABLES = [
  "durable_workflow_events",
  "durable_workflow_links",
  "durable_workflow_refs",
  "durable_workflow_runs",
  "durable_workflow_signals",
  "durable_workflow_steps",
  "durable_workflow_timers",
] as const;

function listDurableWorkflowTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table'
            AND name LIKE 'durable_workflow_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function listSchemaObjects(db: DatabaseSync): Array<{
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}> {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

describe("durable workflow sqlite store", () => {
  it("records the supported durable schema version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates runs, dedupes idempotency keys, and appends ordered events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const first = store.createRun({
        workflowId: "test.workflow",
        idempotencyKey: "request-1",
        requestHash: "hash-1",
        metadata: { surface: "test" },
        now: 100,
      });
      const duplicate = store.createRun({
        workflowId: "test.workflow",
        idempotencyKey: "request-1",
        requestHash: "hash-1",
        now: 200,
      });
      expect(duplicate.workflowRunId).toBe(first.workflowRunId);

      const started = store.appendEvent({
        workflowRunId: first.workflowRunId,
        eventType: "workflow.started",
        payload: { ok: true },
      });
      const completed = store.appendEvent({
        workflowRunId: first.workflowRunId,
        eventType: "workflow.completed",
      });
      expect(store.listOpenRuns({ workflowId: "test.workflow" })).toMatchObject([
        {
          workflowRunId: first.workflowRunId,
          workflowId: "test.workflow",
          status: "received",
        },
      ]);
      const terminal = store.updateRun({
        workflowRunId: first.workflowRunId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 300,
        now: 300,
      });

      expect(started.eventSeq).toBe(1);
      expect(completed.eventSeq).toBe(2);
      expect(terminal).toMatchObject({
        workflowRunId: first.workflowRunId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 300,
      });
      expect(store.getTimeline(first.workflowRunId).map((event) => event.eventType)).toEqual([
        "workflow.started",
        "workflow.completed",
      ]);
      expect(store.listOpenRuns({ workflowId: "test.workflow" })).toEqual([]);
      expect(store.getStats()).toMatchObject({ runs: 1, events: 2, steps: 0, openRuns: 0 });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores core workflow primitives for steps, refs, links, timers, signals, and claims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "parent",
        now: 100,
      });
      const child = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "child",
        parentWorkflowRunId: parent.workflowRunId,
        now: 110,
      });
      const claimed = store.claimNextRunnableRun({
        workflowId: "test.workflow",
        workerId: "worker-1",
        claimTtlMs: 1_000,
        now: 120,
      });
      expect(claimed).toMatchObject({
        workflowRunId: parent.workflowRunId,
        claimedBy: "worker-1",
        recoveryState: "claimed",
        claimExpiresAt: 1_120,
      });
      const released = store.releaseRunClaim({
        workflowRunId: parent.workflowRunId,
        workerId: "worker-1",
        now: 130,
      });
      expect(released).toMatchObject({
        workflowRunId: parent.workflowRunId,
        recoveryState: "runnable",
      });

      const inputRef = store.createRef({
        workflowRunId: parent.workflowRunId,
        refKind: "input",
        mediaType: "application/json",
        hash: "input-hash",
        storageKind: "inline",
        storageUri: "inline:test",
        now: 140,
      });
      expect(store.getRef(inputRef.refId)).toMatchObject({
        refKind: "input",
        storageKind: "inline",
        hash: "input-hash",
      });

      const step = store.createStep({
        workflowRunId: parent.workflowRunId,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        inputRef: inputRef.refId,
        idempotencyKey: "fan-in-1",
        metadata: { policy: "all_terminal" },
        now: 150,
      });
      const duplicateStep = store.createStep({
        workflowRunId: parent.workflowRunId,
        stepType: "fan_in",
        idempotencyKey: "fan-in-1",
        now: 160,
      });
      expect(duplicateStep.stepId).toBe(step.stepId);

      const updatedStep = store.updateStep({
        workflowRunId: parent.workflowRunId,
        stepId: step.stepId,
        status: "succeeded",
        recoveryState: "terminal",
        outputRef: "output-ref",
        completedAt: 170,
        now: 170,
      });
      expect(updatedStep).toMatchObject({
        stepId: step.stepId,
        status: "succeeded",
        outputRef: "output-ref",
        completedAt: 170,
      });
      expect(store.listSteps(parent.workflowRunId)).toHaveLength(1);

      const executableStep = store.createStep({
        workflowRunId: parent.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "tool-1",
        now: 175,
      });
      const claimedStep = store.claimNextRunnableStep({
        workflowId: "test.workflow",
        stepType: "tool",
        workerId: "worker-1",
        claimTtlMs: 1_000,
        now: 176,
      });
      expect(claimedStep).toMatchObject({
        workflowRunId: parent.workflowRunId,
        stepId: executableStep.stepId,
        status: "queued",
        recoveryState: "claimed",
        claimedBy: "worker-1",
        claimExpiresAt: 1_176,
      });
      expect(
        store.releaseStepClaim({
          workflowRunId: parent.workflowRunId,
          stepId: executableStep.stepId,
          workerId: "worker-1",
          now: 177,
        }),
      ).toMatchObject({
        stepId: executableStep.stepId,
        recoveryState: "runnable",
      });

      const link = store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: step.stepId,
        childWorkflowRunId: child.workflowRunId,
        linkType: "child_workflow",
        status: "running",
        now: 180,
      });
      expect(link.status).toBe("running");
      expect(
        store.updateLink({
          parentWorkflowRunId: parent.workflowRunId,
          parentStepId: step.stepId,
          childWorkflowRunId: child.workflowRunId,
          status: "succeeded",
          now: 190,
        }),
      ).toMatchObject({ status: "succeeded" });
      expect(store.listChildLinks(parent.workflowRunId)).toHaveLength(1);

      const timer = store.createTimer({
        workflowRunId: parent.workflowRunId,
        stepId: step.stepId,
        timerType: "retry",
        dueAt: 200,
        now: 195,
      });
      expect(store.listDueTimers(199)).toEqual([]);
      expect(store.listDueTimers(200)).toMatchObject([{ timerId: timer.timerId }]);
      expect(
        store.updateTimer({ timerId: timer.timerId, status: "fired", now: 201 }),
      ).toMatchObject({
        status: "fired",
        firedAt: 201,
      });

      const signal = store.createSignal({
        workflowRunId: parent.workflowRunId,
        stepId: step.stepId,
        signalType: "human_input",
        idempotencyKey: "signal-1",
        payloadRef: inputRef.refId,
        now: 210,
      });
      const duplicateSignal = store.createSignal({
        workflowRunId: parent.workflowRunId,
        signalType: "human_input",
        idempotencyKey: "signal-1",
        now: 211,
      });
      expect(duplicateSignal.signalId).toBe(signal.signalId);
      expect(store.consumeSignal({ signalId: signal.signalId, now: 220 })).toMatchObject({
        signalId: signal.signalId,
        consumedAt: 220,
      });
      expect(store.listSignals(parent.workflowRunId)).toHaveLength(1);
      expect(store.listPendingSignals()).toEqual([]);
      expect(store.getStats()).toMatchObject({ runs: 2, steps: 2 });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim retry-scheduled runs or steps before recovery queues them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 110,
      });

      expect(
        store.claimNextRunnableRun({
          workflowId: "test.workflow",
          workerId: "worker-1",
          claimTtlMs: 1_000,
          now: 120,
        }),
      ).toBeUndefined();
      expect(
        store.claimNextRunnableStep({
          workflowId: "test.workflow",
          workerId: "worker-1",
          claimTtlMs: 1_000,
          now: 120,
        }),
      ).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds durable tables to an existing shared state database without rewriting existing rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const existingDb = new DatabaseSync(dbPath);
    try {
      existingDb.exec(`
        CREATE TABLE diagnostic_events (
          scope TEXT NOT NULL,
          event_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope, event_key)
        );
      `);
      existingDb
        .prepare(
          `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run("state", "startup", '{"ok":true}', 123);
      expect(listDurableWorkflowTables(existingDb)).toEqual([]);
    } finally {
      existingDb.close();
    }

    const store = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      });
    } finally {
      store.close();
    }

    const upgradedDb = new DatabaseSync(dbPath);
    try {
      expect(listDurableWorkflowTables(upgradedDb)).toEqual([...DURABLE_WORKFLOW_TABLES].sort());
      expect(
        upgradedDb
          .prepare(
            `SELECT scope, event_key, payload_json, created_at
               FROM diagnostic_events
              WHERE scope = ?
                AND event_key = ?`,
          )
          .get("state", "startup"),
      ).toEqual({
        scope: "state",
        event_key: "startup",
        payload_json: '{"ok":true}',
        created_at: 123,
      });
      expect(
        upgradedDb.prepare("SELECT schema_name, version FROM durable_schema_migrations").get(),
      ).toEqual({
        schema_name: "durable_workflows",
        version: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      });
      expect(upgradedDb.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      upgradedDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds durable tables to a released pre-durable shared state database shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(dbPath);
    try {
      legacyDb.exec(`
        CREATE TABLE diagnostic_events (
          scope TEXT NOT NULL,
          event_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope, event_key)
        );

        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE task_runs (
          task_id TEXT NOT NULL PRIMARY KEY,
          runtime TEXT NOT NULL,
          task_kind TEXT,
          source_id TEXT,
          requester_session_key TEXT,
          owner_key TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          child_session_key TEXT,
          parent_flow_id TEXT,
          parent_task_id TEXT,
          agent_id TEXT,
          run_id TEXT,
          label TEXT,
          task TEXT NOT NULL,
          status TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          last_event_at INTEGER,
          cleanup_after INTEGER,
          error TEXT,
          progress_summary TEXT,
          terminal_summary TEXT,
          terminal_outcome TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("state", "state", 1, null, "2026.6.1", 100, 100);
      legacyDb
        .prepare(
          `INSERT INTO task_runs (
            task_id,
            runtime,
            requester_session_key,
            owner_key,
            scope_kind,
            task,
            status,
            delivery_status,
            notify_policy,
            created_at,
            last_event_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-task",
          "subagent",
          "agent:main:main",
          "agent:main:main",
          "session",
          "Continue long-running work",
          "running",
          "pending",
          "done_only",
          110,
          120,
        );
      expect(listDurableWorkflowTables(legacyDb)).toEqual([]);
    } finally {
      legacyDb.close();
    }

    const store = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      });
    } finally {
      store.close();
    }

    const upgradedDb = new DatabaseSync(dbPath);
    try {
      expect(listDurableWorkflowTables(upgradedDb)).toEqual([...DURABLE_WORKFLOW_TABLES].sort());
      expect(
        upgradedDb.prepare("SELECT * FROM schema_meta WHERE meta_key = ?").get("state"),
      ).toEqual({
        meta_key: "state",
        role: "state",
        schema_version: 1,
        agent_id: null,
        app_version: "2026.6.1",
        created_at: 100,
        updated_at: 100,
      });
      expect(
        upgradedDb
          .prepare(
            `SELECT task_id, runtime, requester_session_key, owner_key, scope_kind, task,
                    status, delivery_status, notify_policy, created_at, last_event_at
               FROM task_runs
              WHERE task_id = ?`,
          )
          .get("legacy-task"),
      ).toEqual({
        task_id: "legacy-task",
        runtime: "subagent",
        requester_session_key: "agent:main:main",
        owner_key: "agent:main:main",
        scope_kind: "session",
        task: "Continue long-running work",
        status: "running",
        delivery_status: "pending",
        notify_policy: "done_only",
        created_at: 110,
        last_event_at: 120,
      });
      expect(
        upgradedDb.prepare("SELECT schema_name, version FROM durable_schema_migrations").get(),
      ).toEqual({
        schema_name: "durable_workflows",
        version: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      });
      expect(upgradedDb.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      upgradedDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a newer durable schema version without mutating workflow tables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const setupDb = new DatabaseSync(dbPath);
    let schemaBefore: ReturnType<typeof listSchemaObjects>;
    try {
      setupDb.exec(`
        CREATE TABLE diagnostic_events (
          scope TEXT NOT NULL,
          event_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope, event_key)
        );

        CREATE TABLE durable_schema_migrations (
          schema_name TEXT NOT NULL PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at INTEGER NOT NULL,
          metadata_json TEXT
        );
      `);
      setupDb
        .prepare(
          `INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run("durable_workflows", DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION + 1, 100, null);
      schemaBefore = listSchemaObjects(setupDb);
      expect(listDurableWorkflowTables(setupDb)).toEqual([]);
    } finally {
      setupDb.close();
    }

    expect(() => openDurableWorkflowSqliteStore({ path: dbPath })).toThrow(
      /newer than supported version/,
    );

    const verifyDb = new DatabaseSync(dbPath);
    try {
      expect(listSchemaObjects(verifyDb)).toEqual(schemaBefore);
      expect(listDurableWorkflowTables(verifyDb)).toEqual([]);
      expect(
        verifyDb
          .prepare(
            "SELECT schema_name, version, applied_at, metadata_json FROM durable_schema_migrations",
          )
          .get(),
      ).toEqual({
        schema_name: "durable_workflows",
        version: DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION + 1,
        applied_at: 100,
        metadata_json: null,
      });
      expect(verifyDb.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      verifyDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
