import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import {
  DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION,
  openDurableRuntimeSqliteStore,
} from "./sqlite-store.js";

const DURABLE_TABLES = [
  "durable_runtime_events",
  "durable_runtime_links",
  "durable_runtime_refs",
  "durable_runtime_runs",
  "durable_runtime_signals",
  "durable_runtime_steps",
  "durable_runtime_timers",
] as const;

describe("durable runtime sqlite store", () => {
  it("records the supported durable schema version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION,
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
      ).run("durable_runtime", DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION + 1, 100, null);
    } finally {
      db.close();
    }

    try {
      expect(() => openDurableRuntimeSqliteStore({ path: dbPath })).toThrow(
        /newer than supported version/,
      );
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const runtimeTables = verifyDb
          .prepare(
            `SELECT name FROM sqlite_master
               WHERE type = 'table'
                 AND name LIKE 'durable_runtime_%'
               ORDER BY name`,
          )
          .all();
        expect(runtimeTables).toEqual([]);
      } finally {
        verifyDb.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a pre-durable shared state database without touching existing rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-upgrade-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE schema_meta (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE cron_jobs (
          job_id TEXT NOT NULL PRIMARY KEY,
          definition_json TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(
        "openclaw_state_schema_version",
        "2026.6.8",
      );
      db.prepare("INSERT INTO cron_jobs (job_id, definition_json, enabled) VALUES (?, ?, ?)").run(
        "legacy-job",
        JSON.stringify({ schedule: "*/5 * * * *", task: "legacy" }),
        1,
      );
    } finally {
      db.close();
    }

    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION,
      });
      const run = store.createRun({
        operationKind: "openclaw.chat.send",
        idempotencyKey: "upgrade-smoke",
        status: "succeeded",
        recoveryState: "terminal",
        sourceType: "chat.send",
        sourceRef: "agent:upgrade:test",
        now: 100,
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "upgrade.smoke",
        now: 100,
      });
    } finally {
      store.close();
    }

    const verifyDb = new DatabaseSync(dbPath);
    try {
      expect(
        verifyDb
          .prepare("SELECT value FROM schema_meta WHERE key = ?")
          .get("openclaw_state_schema_version"),
      ).toEqual({ value: "2026.6.8" });
      expect(verifyDb.prepare("SELECT job_id, enabled FROM cron_jobs").all()).toEqual([
        { job_id: "legacy-job", enabled: 1 },
      ]);
      const migration = verifyDb
        .prepare(
          "SELECT version, metadata_json FROM durable_schema_migrations WHERE schema_name = ?",
        )
        .get("durable_runtime") as { version: number; metadata_json: string };
      expect(migration.version).toBe(DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION);
      expect(JSON.parse(migration.metadata_json)).toMatchObject({
        kind: "fresh-install",
        previousVersion: 0,
      });
      const runtimeTables = verifyDb
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name LIKE 'durable_runtime_%'
             ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(runtimeTables.map((row) => row.name)).toEqual([...DURABLE_TABLES]);
    } finally {
      verifyDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens partial early durable schemas before creating indexes on added columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-upgrade-"));
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
        INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
          VALUES ('durable_runtime', ${DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION}, 100, '{"kind":"early-durable"}');
        CREATE TABLE durable_runtime_runs (
          runtime_run_id TEXT NOT NULL PRIMARY KEY,
          operation_kind TEXT NOT NULL,
          operation_version TEXT NOT NULL DEFAULT '1',
          idempotency_key TEXT,
          request_hash TEXT,
          status TEXT NOT NULL,
          source_type TEXT,
          source_ref TEXT,
          input_ref TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          recovery_state TEXT NOT NULL DEFAULT 'runnable',
          checkpoint_ref TEXT,
          metadata_json TEXT
        );
        INSERT INTO durable_runtime_runs (
          runtime_run_id, operation_kind, operation_version, idempotency_key, request_hash,
          status, source_type, source_ref, input_ref, created_at, updated_at, completed_at,
          recovery_state, checkpoint_ref, metadata_json
        ) VALUES (
          'run_legacy_partial', 'openclaw.agent.turn', '1', 'legacy-partial', NULL,
          'running', 'agent', 'agent:legacy:main', NULL, 10, 10, NULL,
          'running', NULL, '{"legacy":true}'
        );
      `);
    } finally {
      db.close();
    }

    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      expect(store.getRun("run_legacy_partial")).toMatchObject({
        runtimeRunId: "run_legacy_partial",
        operationKind: "openclaw.agent.turn",
        status: "running",
        recoveryState: "running",
        sourceRef: "agent:legacy:main",
        metadata: { legacy: true },
      });
      expect(
        store.updateRun({
          runtimeRunId: "run_legacy_partial",
          workUnitId: "wu:legacy",
          reportRouteId: "discord:legacy-main",
          now: 20,
        }),
      ).toMatchObject({
        runtimeRunId: "run_legacy_partial",
        workUnitId: "wu:legacy",
        reportRouteId: "discord:legacy-main",
      });
      expect(store.getStats()).toMatchObject({ runs: 1, schemaVersion: 1 });
    } finally {
      store.close();
    }

    const verifyDb = new DatabaseSync(dbPath);
    try {
      const columns = verifyDb.prepare("PRAGMA table_info(durable_runtime_runs)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "work_unit_id",
          "report_route_id",
          "claimed_by",
          "claim_expires_at",
          "heartbeat_at",
        ]),
      );
      const indexes = verifyDb
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_durable_runtime_runs_work_unit', 'idx_durable_runtime_runs_report_route')
             ORDER BY name`,
        )
        .all();
      expect(indexes).toEqual([
        { name: "idx_durable_runtime_runs_report_route" },
        { name: "idx_durable_runtime_runs_work_unit" },
      ]);
    } finally {
      verifyDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses shared state private-mode hardening when it creates the state database", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-state-mode-"));
    fs.chmodSync(stateDir, 0o755);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const pathname = resolveDurableRuntimeSqlitePath(env);
    const store = openDurableRuntimeSqliteStore({ env });
    try {
      expect(fs.statSync(path.dirname(pathname)).mode & 0o777).toBe(0o700);
      for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
        if (fs.existsSync(candidate)) {
          expect(fs.statSync(candidate).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("creates runs, dedupes idempotency keys, and appends ordered events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const first = store.createRun({
        operationKind: "test.runtime",
        idempotencyKey: "request-1",
        requestHash: "hash-1",
        workUnitId: "wu:test:card-1",
        reportRouteId: "discord:bo-main",
        metadata: { surface: "test" },
        now: 100,
      });
      const duplicate = store.createRun({
        operationKind: "test.runtime",
        idempotencyKey: "request-1",
        requestHash: "hash-1",
        now: 200,
      });
      expect(duplicate.runtimeRunId).toBe(first.runtimeRunId);

      const started = store.appendEvent({
        runtimeRunId: first.runtimeRunId,
        eventType: "runtime.started",
        payload: { ok: true },
      });
      const completed = store.appendEvent({
        runtimeRunId: first.runtimeRunId,
        eventType: "runtime.completed",
      });
      expect(store.listOpenRuns({ operationKind: "test.runtime" })).toMatchObject([
        {
          runtimeRunId: first.runtimeRunId,
          operationKind: "test.runtime",
          status: "received",
          workUnitId: "wu:test:card-1",
          reportRouteId: "discord:bo-main",
        },
      ]);
      const terminal = store.updateRun({
        runtimeRunId: first.runtimeRunId,
        status: "succeeded",
        recoveryState: "terminal",
        workUnitId: "wu:test:card-1-updated",
        completedAt: 300,
        now: 300,
      });

      expect(started.eventSeq).toBe(1);
      expect(completed.eventSeq).toBe(2);
      expect(terminal).toMatchObject({
        runtimeRunId: first.runtimeRunId,
        status: "succeeded",
        recoveryState: "terminal",
        workUnitId: "wu:test:card-1-updated",
        reportRouteId: "discord:bo-main",
        completedAt: 300,
      });
      expect(store.getTimeline(first.runtimeRunId).map((event) => event.eventType)).toEqual([
        "runtime.started",
        "runtime.completed",
      ]);
      expect(store.listOpenRuns({ operationKind: "test.runtime" })).toEqual([]);
      expect(store.getStats()).toMatchObject({ runs: 1, events: 2, steps: 0, openRuns: 0 });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps terminal runs immutable except exact idempotent no-ops", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const terminal = store.createRun({
        operationKind: "test.runtime",
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 100,
        metadata: { outcome: "ok" },
        now: 100,
      });

      expect(
        store.updateRun({
          runtimeRunId: terminal.runtimeRunId,
          status: "succeeded",
          recoveryState: "terminal",
          completedAt: 100,
          metadata: { outcome: "ok" },
          now: 200,
        }),
      ).toMatchObject({
        runtimeRunId: terminal.runtimeRunId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 100,
        updatedAt: 100,
      });
      expect(
        store.updateRun({
          runtimeRunId: terminal.runtimeRunId,
          status: "running",
          recoveryState: "running",
          completedAt: null,
          now: 300,
        }),
      ).toBeUndefined();
      expect(
        store.updateRun({
          runtimeRunId: terminal.runtimeRunId,
          status: "failed",
          recoveryState: "terminal",
          completedAt: 350,
          now: 350,
        }),
      ).toBeUndefined();
      expect(
        store.updateRun({
          runtimeRunId: terminal.runtimeRunId,
          metadata: { outcome: "changed" },
          now: 400,
        }),
      ).toBeUndefined();
      expect(store.getRun(terminal.runtimeRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 100,
        updatedAt: 100,
        metadata: { outcome: "ok" },
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not release terminal run claims back to runnable state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      expect(
        store.claimNextRunnableRun({
          operationKind: "test.runtime",
          workerId: "worker-terminal",
          claimTtlMs: 1_000,
          now: 110,
        }),
      ).toMatchObject({
        runtimeRunId: run.runtimeRunId,
        claimedBy: "worker-terminal",
        recoveryState: "claimed",
      });
      expect(
        store.updateRun({
          runtimeRunId: run.runtimeRunId,
          status: "lost",
          recoveryState: "terminal",
          completedAt: 120,
          now: 120,
        }),
      ).toMatchObject({
        status: "lost",
        recoveryState: "terminal",
        claimedBy: "worker-terminal",
      });

      expect(
        store.releaseRunClaim({
          runtimeRunId: run.runtimeRunId,
          workerId: "worker-terminal",
          now: 130,
        }),
      ).toBeUndefined();
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "terminal",
        completedAt: 120,
        claimedBy: "worker-terminal",
        claimExpiresAt: 1_110,
        updatedAt: 120,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores core runtime primitives for steps, refs, links, timers, signals, and claims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "parent",
        now: 100,
      });
      const child = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "child",
        parentRuntimeRunId: parent.runtimeRunId,
        now: 110,
      });
      const claimed = store.claimNextRunnableRun({
        operationKind: "test.runtime",
        workerId: "worker-1",
        claimTtlMs: 1_000,
        now: 120,
      });
      expect(claimed).toMatchObject({
        runtimeRunId: parent.runtimeRunId,
        claimedBy: "worker-1",
        recoveryState: "claimed",
        claimExpiresAt: 1_120,
      });
      const released = store.releaseRunClaim({
        runtimeRunId: parent.runtimeRunId,
        workerId: "worker-1",
        now: 130,
      });
      expect(released).toMatchObject({
        runtimeRunId: parent.runtimeRunId,
        recoveryState: "runnable",
      });

      const inputRef = store.createRef({
        runtimeRunId: parent.runtimeRunId,
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
        runtimeRunId: parent.runtimeRunId,
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        inputRef: inputRef.refId,
        idempotencyKey: "fan-in-1",
        metadata: { policy: "all_terminal" },
        now: 150,
      });
      const duplicateStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepType: "fan_in",
        idempotencyKey: "fan-in-1",
        now: 160,
      });
      expect(duplicateStep.stepId).toBe(step.stepId);

      const updatedStep = store.updateStep({
        runtimeRunId: parent.runtimeRunId,
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
      expect(store.listSteps(parent.runtimeRunId)).toHaveLength(1);

      const executableStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        idempotencyKey: "tool-1",
        now: 175,
      });
      const claimedStep = store.claimNextRunnableStep({
        operationKind: "test.runtime",
        stepType: "tool",
        workerId: "worker-1",
        claimTtlMs: 1_000,
        now: 176,
      });
      expect(claimedStep).toMatchObject({
        runtimeRunId: parent.runtimeRunId,
        stepId: executableStep.stepId,
        status: "queued",
        recoveryState: "claimed",
        claimedBy: "worker-1",
        claimExpiresAt: 1_176,
      });
      expect(
        store.releaseStepClaim({
          runtimeRunId: parent.runtimeRunId,
          stepId: executableStep.stepId,
          workerId: "worker-1",
          now: 177,
        }),
      ).toMatchObject({
        stepId: executableStep.stepId,
        recoveryState: "runnable",
      });

      const link = store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: step.stepId,
        childRuntimeRunId: child.runtimeRunId,
        linkType: "child_runtime",
        status: "running",
        now: 180,
      });
      expect(link.status).toBe("running");
      expect(
        store.updateLink({
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId: step.stepId,
          childRuntimeRunId: child.runtimeRunId,
          status: "succeeded",
          now: 190,
        }),
      ).toMatchObject({ status: "succeeded" });
      expect(store.listChildLinks(parent.runtimeRunId)).toHaveLength(1);

      const timer = store.createTimer({
        runtimeRunId: parent.runtimeRunId,
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
        runtimeRunId: parent.runtimeRunId,
        stepId: step.stepId,
        signalType: "human_input",
        idempotencyKey: "signal-1",
        payloadRef: inputRef.refId,
        now: 210,
      });
      const duplicateSignal = store.createSignal({
        runtimeRunId: parent.runtimeRunId,
        signalType: "human_input",
        idempotencyKey: "signal-1",
        now: 211,
      });
      expect(duplicateSignal.signalId).toBe(signal.signalId);
      expect(store.consumeSignal({ signalId: signal.signalId, now: 220 })).toMatchObject({
        signalId: signal.signalId,
        consumedAt: 220,
      });
      expect(store.listSignals(parent.runtimeRunId)).toHaveLength(1);
      expect(store.listPendingSignals()).toEqual([]);
      expect(store.getStats()).toMatchObject({ runs: 2, steps: 2 });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps terminal steps immutable except exact idempotent no-ops", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "tool_1",
        stepType: "tool",
        status: "running",
        recoveryState: "running",
        metadata: { phase: "running" },
        now: 110,
      });
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          outputRef: "output-ref",
          completedAt: 120,
          metadata: { phase: "done" },
          now: 120,
        }),
      ).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
        outputRef: "output-ref",
        completedAt: 120,
        metadata: { phase: "done" },
      });

      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          outputRef: "output-ref",
          completedAt: 120,
          metadata: { phase: "done" },
          now: 130,
        }),
      ).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
        updatedAt: 120,
      });
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          status: "waiting",
          recoveryState: "waiting_child",
          completedAt: null,
          now: 140,
        }),
      ).toBeUndefined();
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          status: "failed",
          recoveryState: "terminal",
          errorRef: "error-ref",
          completedAt: 145,
          now: 145,
        }),
      ).toBeUndefined();
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          metadata: { phase: "changed" },
          now: 150,
        }),
      ).toBeUndefined();
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          outputRef: "output-ref",
          completedAt: 120,
          updatedAt: 120,
          metadata: { phase: "done" },
        },
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not release terminal step claims back to runnable state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "tool_terminal_claim",
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      expect(
        store.claimNextRunnableStep({
          operationKind: "test.runtime",
          workerId: "worker-terminal",
          claimTtlMs: 1_000,
          now: 120,
        }),
      ).toMatchObject({
        stepId: step.stepId,
        claimedBy: "worker-terminal",
        recoveryState: "claimed",
      });
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          expectedClaimedBy: "worker-terminal",
          status: "failed",
          recoveryState: "terminal",
          errorRef: "error-ref",
          completedAt: 130,
          now: 130,
        }),
      ).toMatchObject({
        status: "failed",
        recoveryState: "terminal",
        claimedBy: "worker-terminal",
      });

      expect(
        store.releaseStepClaim({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          workerId: "worker-terminal",
          now: 140,
        }),
      ).toBeUndefined();
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "failed",
          recoveryState: "terminal",
          errorRef: "error-ref",
          completedAt: 130,
          claimedBy: "worker-terminal",
          claimExpiresAt: 1_120,
          updatedAt: 130,
        },
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim retry-scheduled runs or steps before recovery queues them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 110,
      });

      expect(
        store.claimNextRunnableRun({
          operationKind: "test.runtime",
          workerId: "worker-1",
          claimTtlMs: 1_000,
          now: 120,
        }),
      ).toBeUndefined();
      expect(
        store.claimNextRunnableStep({
          operationKind: "test.runtime",
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

  it("reclaims expired run and step leases without accepting stale owner writes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      expect(
        store.claimNextRunnableRun({
          operationKind: "test.runtime",
          workerId: "worker-1",
          claimTtlMs: 10,
          now: 120,
        }),
      ).toMatchObject({
        runtimeRunId: run.runtimeRunId,
        claimedBy: "worker-1",
        claimExpiresAt: 130,
      });
      expect(
        store.claimNextRunnableRun({
          operationKind: "test.runtime",
          workerId: "worker-2",
          claimTtlMs: 10,
          now: 125,
        }),
      ).toBeUndefined();
      expect(
        store.claimNextRunnableRun({
          operationKind: "test.runtime",
          workerId: "worker-2",
          claimTtlMs: 10,
          now: 131,
        }),
      ).toMatchObject({
        runtimeRunId: run.runtimeRunId,
        claimedBy: "worker-2",
        claimExpiresAt: 141,
      });
      expect(
        store.releaseRunClaim({
          runtimeRunId: run.runtimeRunId,
          workerId: "worker-1",
          now: 132,
        }),
      ).toBeUndefined();
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        claimedBy: "worker-2",
        recoveryState: "claimed",
      });

      expect(
        store.claimNextRunnableStep({
          operationKind: "test.runtime",
          workerId: "worker-1",
          claimTtlMs: 10,
          now: 140,
        }),
      ).toMatchObject({
        stepId: step.stepId,
        claimedBy: "worker-1",
        claimExpiresAt: 150,
      });
      expect(
        store.claimNextRunnableStep({
          operationKind: "test.runtime",
          workerId: "worker-2",
          claimTtlMs: 10,
          now: 145,
        }),
      ).toBeUndefined();
      expect(
        store.claimNextRunnableStep({
          operationKind: "test.runtime",
          workerId: "worker-2",
          claimTtlMs: 10,
          now: 151,
        }),
      ).toMatchObject({
        stepId: step.stepId,
        claimedBy: "worker-2",
        claimExpiresAt: 161,
      });
      expect(
        store.releaseStepClaim({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          workerId: "worker-1",
          now: 152,
        }),
      ).toBeUndefined();
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          expectedClaimedBy: "worker-1",
          status: "succeeded",
          recoveryState: "terminal",
          now: 155,
        }),
      ).toBeUndefined();
      const completedStep = store.updateStep({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        expectedClaimedBy: "worker-2",
        status: "succeeded",
        recoveryState: "terminal",
        claimedBy: null,
        claimExpiresAt: null,
        now: 160,
      });
      expect(completedStep).toMatchObject({
        stepId: step.stepId,
        status: "succeeded",
        recoveryState: "terminal",
      });
      expect(completedStep?.claimedBy).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paginates timelines and compacts only terminal run history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const active = store.createRun({
        operationKind: "test.runtime",
        status: "running",
        recoveryState: "running",
      });
      store.appendEvent({ runtimeRunId: active.runtimeRunId, eventType: "active.one" });
      expect(store.compactTerminalRun({ runtimeRunId: active.runtimeRunId })).toEqual({
        runtimeRunId: active.runtimeRunId,
        compacted: false,
        removedEvents: 0,
      });

      const terminal = store.createRun({
        operationKind: "test.runtime",
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 200,
      });
      for (let index = 1; index <= 5; index += 1) {
        store.appendEvent({
          runtimeRunId: terminal.runtimeRunId,
          eventType: `terminal.${index}`,
        });
      }
      expect(
        store
          .getTimeline(terminal.runtimeRunId, { afterEventSeq: 2, limit: 2 })
          .map((event) => [event.eventSeq, event.eventType]),
      ).toEqual([
        [3, "terminal.3"],
        [4, "terminal.4"],
      ]);

      expect(
        store.compactTerminalRun({
          runtimeRunId: terminal.runtimeRunId,
          keepLastEvents: 2,
          now: 500,
        }),
      ).toEqual({
        runtimeRunId: terminal.runtimeRunId,
        compacted: true,
        removedEvents: 3,
      });
      expect(store.getTimeline(terminal.runtimeRunId).map((event) => event.eventType)).toEqual([
        "terminal.4",
        "terminal.5",
        "runtime.history.compacted",
      ]);
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
              AND name LIKE 'durable_runtime_%'
            ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(durableTablesBefore).toEqual([]);
    } finally {
      existingDb.close();
    }

    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    store.close();

    const upgradedDb = new DatabaseSync(dbPath);
    try {
      const durableTablesAfter = upgradedDb
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'durable_runtime_%'
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
