import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
  openDurableWorkflowSqliteStore,
} from "./sqlite-store.js";

const DURABLE_TABLES = [
  "durable_workflow_events",
  "durable_workflow_links",
  "durable_workflow_refs",
  "durable_workflow_runs",
  "durable_workflow_signals",
  "durable_workflow_steps",
  "durable_workflow_timers",
] as const;

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

  it("rejects durable stores from a newer schema version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE durable_schema_migrations (
          schema_name TEXT NOT NULL PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at INTEGER NOT NULL,
          metadata_json TEXT
        );
      `);
      db.prepare(
        `INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
         VALUES (?, ?, ?, ?)`,
      ).run("durable_workflows", DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION + 1, 100, null);
    } finally {
      db.close();
    }

    try {
      expect(() => openDurableWorkflowSqliteStore({ path: dbPath })).toThrow(
        /newer than supported version/,
      );
    } finally {
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
      const durableTablesBefore = existingDb
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'durable_workflow_%'
            ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(durableTablesBefore).toEqual([]);
    } finally {
      existingDb.close();
    }

    const store = openDurableWorkflowSqliteStore({ path: dbPath });
    store.close();

    const upgradedDb = new DatabaseSync(dbPath);
    try {
      const durableTablesAfter = upgradedDb
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'durable_workflow_%'
            ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(durableTablesAfter.map((row) => row.name)).toEqual([...DURABLE_TABLES].sort());
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
      expect(upgradedDb.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      upgradedDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
