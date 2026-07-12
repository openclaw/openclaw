import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

const DURABLE_TABLES = [
  "durable_runtime_continuation_cleanup",
  "durable_runtime_dedupe_ledger",
  "durable_runtime_events",
  "durable_runtime_links",
  "durable_runtime_parent_wakes",
  "durable_runtime_refs",
  "durable_runtime_runs",
  "durable_runtime_signals",
  "durable_runtime_steps",
  "durable_runtime_timers",
  "durable_runtime_uncertainty_facts",
  "durable_runtime_wake_delivery_attempts",
] as const;

describe("durable runtime sqlite store", () => {
  it("reports the shared state schema version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects durable stores from a newer shared state schema version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }

    try {
      expect(() => openDurableRuntimeSqliteStore({ path: dbPath })).toThrow(/newer schema version/);
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

  it("opens a pre-durable shared state database without touching existing rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-upgrade-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE diagnostic_events (
          scope TEXT NOT NULL,
          event_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope, event_key)
        );
      `);
      db.prepare(
        `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        "state",
        "pre-durable",
        JSON.stringify({ schedule: "*/5 * * * *", task: "legacy" }),
        123,
      );
    } finally {
      db.close();
    }

    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
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
        eventTime: 100,
      });
    } finally {
      store.close();
    }

    const verifyDb = new DatabaseSync(dbPath);
    try {
      expect(
        verifyDb
          .prepare(
            `SELECT scope, event_key, payload_json, created_at
               FROM diagnostic_events
              WHERE scope = ?
                AND event_key = ?`,
          )
          .get("state", "pre-durable"),
      ).toEqual({
        scope: "state",
        event_key: "pre-durable",
        payload_json: JSON.stringify({ schedule: "*/5 * * * *", task: "legacy" }),
        created_at: 123,
      });
      expect(
        verifyDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("durable_schema_migrations"),
      ).toBeUndefined();
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
      expect(store.getStats()).toMatchObject({
        runs: 1,
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
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

  it("keeps a shared state handle open while another durable store still owns it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    const first = openDurableRuntimeSqliteStore({ path: dbPath });
    const second = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const firstRun = first.createRun({
        runtimeRunId: "run-first-owner",
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });

      first.close();

      expect(second.getRun(firstRun.runtimeRunId)).toMatchObject({
        runtimeRunId: firstRun.runtimeRunId,
        status: "queued",
      });
      expect(
        second.createRun({
          runtimeRunId: "run-second-owner-after-first-close",
          operationKind: "test.runtime",
          status: "queued",
          recoveryState: "runnable",
          now: 200,
        }),
      ).toMatchObject({
        runtimeRunId: "run-second-owner-after-first-close",
        status: "queued",
      });
    } finally {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases the shared state lease if durable facade construction fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    let kyselyCalls = 0;

    vi.resetModules();
    vi.doMock("../infra/kysely-sync.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/kysely-sync.js")>();
      return {
        ...actual,
        getNodeSqliteKysely: <Database>(db: DatabaseSync) => {
          kyselyCalls += 1;
          if (kyselyCalls === 2) {
            throw new Error("durable kysely construction failed");
          }
          return actual.getNodeSqliteKysely<Database>(db);
        },
      };
    });

    try {
      const [
        { openDurableRuntimeSqliteStore: openWithFailingKysely },
        { closeOpenClawStateDatabaseForPath, openOpenClawStateDatabase },
      ] = await Promise.all([import("./sqlite-store.js"), import("../state/openclaw-state-db.js")]);

      expect(() => openWithFailingKysely({ path: dbPath })).toThrow(
        /durable kysely construction failed/,
      );

      const database = openOpenClawStateDatabase({ path: dbPath });
      closeOpenClawStateDatabaseForPath({ path: dbPath });
      expect(database.db.isOpen).toBe(false);
    } finally {
      vi.doUnmock("../infra/kysely-sync.js");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records parent wakes idempotently and keeps terminal wake states immutable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        runtimeRunId: "run_parent",
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const wake = store.createParentWake({
        parentRunId: parent.runtimeRunId,
        parentSessionKey: "agent:parent:session",
        targetAgent: "parent-agent",
        targetSession: "session-1",
        targetChannel: "discord",
        reason: "child_terminal",
        factsRef: "event:child.done",
        sourceRunId: "run_child",
        dedupeKey: "wake:child-terminal:run_child",
        metadata: { evidence: "child terminal" },
        now: 110,
      });
      const duplicate = store.createParentWake({
        parentRunId: parent.runtimeRunId,
        reason: "child_terminal",
        dedupeKey: "wake:child-terminal:run_child",
        now: 120,
      });
      expect(duplicate.wakeId).toBe(wake.wakeId);
      expect(duplicate).toMatchObject({
        parentRunId: parent.runtimeRunId,
        parentSessionKey: "agent:parent:session",
        status: "pending",
        attemptCount: 0,
        metadata: { evidence: "child terminal" },
      });

      expect(
        store.updateParentWake({
          wakeId: wake.wakeId,
          status: "delivered",
          attemptCount: 1,
          lastAttemptAt: 130,
          now: 130,
        }),
      ).toMatchObject({
        status: "delivered",
        attemptCount: 1,
        lastAttemptAt: 130,
        updatedAt: 130,
      });
      expect(
        store.updateParentWake({
          wakeId: wake.wakeId,
          status: "acked",
          ackedAt: 140,
          now: 140,
        }),
      ).toMatchObject({
        status: "acked",
        ackedAt: 140,
      });
      expect(
        store.updateParentWake({
          wakeId: wake.wakeId,
          status: "failed",
          failedReason: "parent unavailable",
          now: 150,
        }),
      ).toBeUndefined();
      expect(
        store.updateParentWake({
          wakeId: wake.wakeId,
          status: "acked",
          attemptCount: 1,
          lastAttemptAt: 130,
          ackedAt: 140,
          now: 160,
        }),
      ).toMatchObject({
        wakeId: wake.wakeId,
        status: "acked",
        updatedAt: 140,
      });
      expect(store.listParentWakes({ parentRunId: parent.runtimeRunId })).toHaveLength(1);
      expect(store.listParentWakes({ status: "acked" })).toMatchObject([{ wakeId: wake.wakeId }]);

      const failedWake = store.createParentWake({
        parentRunId: parent.runtimeRunId,
        reason: "no_handler",
        dedupeKey: "wake:no-handler:1",
        now: 170,
      });
      expect(
        store.updateParentWake({
          wakeId: failedWake.wakeId,
          status: "failed",
          failedReason: "no parent route",
          now: 180,
        }),
      ).toMatchObject({ status: "failed" });
      expect(
        store.updateParentWake({
          wakeId: failedWake.wakeId,
          status: "acked",
          ackedAt: 190,
          now: 190,
        }),
      ).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes wake delivery attempts and parent wake outcomes atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const deliveredWake = store.createParentWake({
        parentSessionKey: "agent:atomic-delivered",
        reason: "child_terminal",
        dedupeKey: "wake:atomic-delivered",
        now: 100,
      });
      const deliveredAttempt = store.recordWakeDeliveryAttempt({
        wakeId: deliveredWake.wakeId,
        dedupeKey: "wake-delivery:atomic-delivered",
        replayPassId: "pass:schedule",
        routeKind: "channel_route",
        routeRef: "discord:thread:atomic-delivered",
        now: 110,
      });
      expect(
        store.claimWakeDeliveryAttempt({
          deliveryAttemptId: deliveredAttempt.deliveryAttemptId,
          replayPassId: "pass:deliver",
          claimTtlMs: 1_000,
          now: 120,
        }),
      ).toMatchObject({
        status: "attempted",
        deliveryClaimedBy: "pass:deliver",
      });

      expect(
        store.finalizeWakeDeliveryAttempt({
          deliveryAttemptId: deliveredAttempt.deliveryAttemptId,
          status: "delivered",
          expectedClaimedBy: "pass:deliver",
          evidence: { kind: "atomic_delivered" },
          attemptedAt: 130,
          deliveredAt: 130,
          wakeStatus: "delivered",
          wakeAttemptCount: 2,
          wakeLastAttemptAt: 130,
          now: 130,
        }),
      ).toMatchObject({
        status: "delivered",
        deliveredAt: 130,
        evidence: { kind: "atomic_delivered" },
      });
      expect(store.getParentWake(deliveredWake.wakeId)).toMatchObject({
        status: "delivered",
        attemptCount: 2,
        lastAttemptAt: 130,
      });

      const ackedWake = store.createParentWake({
        parentSessionKey: "agent:atomic-abort",
        reason: "child_terminal",
        dedupeKey: "wake:atomic-abort",
        now: 200,
      });
      const abortAttempt = store.recordWakeDeliveryAttempt({
        wakeId: ackedWake.wakeId,
        dedupeKey: "wake-delivery:atomic-abort",
        replayPassId: "pass:schedule-abort",
        routeKind: "channel_route",
        routeRef: "discord:thread:atomic-abort",
        now: 210,
      });
      expect(
        store.claimWakeDeliveryAttempt({
          deliveryAttemptId: abortAttempt.deliveryAttemptId,
          replayPassId: "pass:abort",
          claimTtlMs: 1_000,
          now: 220,
        }),
      ).toMatchObject({ status: "attempted" });
      expect(
        store.updateParentWake({
          wakeId: ackedWake.wakeId,
          status: "delivered",
          attemptCount: 1,
          lastAttemptAt: 230,
          now: 230,
        }),
      ).toMatchObject({ status: "delivered" });
      expect(
        store.updateParentWake({
          wakeId: ackedWake.wakeId,
          status: "acked",
          ackedAt: 240,
          now: 240,
        }),
      ).toMatchObject({ status: "acked" });

      expect(
        store.finalizeWakeDeliveryAttempt({
          deliveryAttemptId: abortAttempt.deliveryAttemptId,
          status: "failed",
          expectedClaimedBy: "pass:abort",
          evidence: { kind: "should_not_commit" },
          error: "parent already acked",
          attemptedAt: 250,
          failedAt: 250,
          wakeStatus: "failed",
          wakeAttemptCount: 2,
          wakeLastAttemptAt: 250,
          wakeFailedReason: "parent already acked",
          now: 250,
        }),
      ).toBeUndefined();
      expect(store.getWakeDeliveryAttempt(abortAttempt.deliveryAttemptId)).toMatchObject({
        status: "attempted",
        deliveryClaimedBy: "pass:abort",
      });
      expect(store.getWakeDeliveryAttempt(abortAttempt.deliveryAttemptId)).not.toHaveProperty(
        "failedAt",
      );
      expect(store.getParentWake(ackedWake.wakeId)).toMatchObject({
        status: "acked",
        attemptCount: 1,
        lastAttemptAt: 230,
        ackedAt: 240,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists parent wakes by parent session key with an independent limit binding", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const firstWake = store.createParentWake({
        parentSessionKey: "agent:parent:session",
        reason: "child_terminal",
        dedupeKey: "wake:session:first",
        now: 100,
      });
      const secondWake = store.createParentWake({
        parentSessionKey: "agent:parent:session",
        reason: "child_terminal",
        dedupeKey: "wake:session:second",
        now: 110,
      });
      store.createParentWake({
        parentSessionKey: "agent:other:session",
        reason: "child_terminal",
        dedupeKey: "wake:session:other",
        now: 120,
      });

      expect(store.listParentWakes({ parentSessionKey: "agent:parent:session", limit: 2 })).toEqual(
        [secondWake, firstWake],
      );
      expect(store.listParentWakes({ parentSessionKey: "agent:parent:session", limit: 1 })).toEqual(
        [secondWake],
      );
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores generalized durable wake target fields while preserving parent wake compatibility", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const routeWake = store.createDurableWake({
        targetKind: "external_route",
        targetRef: "slack:channel:C123:thread:456",
        ownerKind: "external_route",
        ownerRef: "slack:channel:C123",
        reportRouteRef: "slack:channel:C123:thread:456",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "report_route",
        reason: "delivery_unknown",
        factsRef: "event:delivery:unknown",
        sourceRunId: "run_reporter",
        dedupeKey: "wake:external-route:1",
        now: 100,
      });

      expect(routeWake).toMatchObject({
        targetKind: "external_route",
        targetRef: "slack:channel:C123:thread:456",
        ownerKind: "external_route",
        ownerRef: "slack:channel:C123",
        reportRouteRef: "slack:channel:C123:thread:456",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "report_route",
      });
      expect(
        store.listDurableWakes({
          targetKind: "external_route",
          targetRef: "slack:channel:C123:thread:456",
        }),
      ).toEqual([routeWake]);
      expect(
        store.listDurableWakes({
          reportRouteRef: "slack:channel:C123:thread:456",
          targetResolutionStatus: "resolved",
        }),
      ).toEqual([routeWake]);

      const parentWake = store.createParentWake({
        parentSessionKey: "agent:parent:session",
        targetKind: "agent_session",
        targetRef: "agent:parent:session",
        ownerKind: "agent_session",
        ownerRef: "agent:parent:session",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "delegation_subagent_child",
        reason: "child_terminal",
        dedupeKey: "wake:parent-compat:1",
        now: 110,
      });
      expect(store.listParentWakes({ parentSessionKey: "agent:parent:session" })).toEqual([
        parentWake,
      ]);
      expect(store.listDurableWakes({ parentSessionKey: "agent:parent:session" })).toEqual([
        parentWake,
      ]);
      expect(() =>
        store.createParentWake({
          targetKind: "operator",
          targetRef: "operator:durable",
          reason: "no_handler",
          dedupeKey: "wake:parent-wrapper-without-parent",
        }),
      ).toThrow(/requires parentRunId or parentSessionKey/);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates v2 parent wake tables to allow generalized durable wake targets", () => {
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

        INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
        VALUES ('durable_runtime', 2, 100, NULL);

        CREATE TABLE durable_runtime_parent_wakes (
          wake_id TEXT NOT NULL PRIMARY KEY,
          parent_run_id TEXT,
          parent_session_key TEXT,
          target_agent TEXT,
          target_session TEXT,
          target_channel TEXT,
          reason TEXT NOT NULL,
          facts_ref TEXT,
          source_run_id TEXT,
          dedupe_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at INTEGER,
          acked_at INTEGER,
          failed_reason TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata_json TEXT,
          CHECK (parent_run_id IS NOT NULL OR parent_session_key IS NOT NULL)
        );

        INSERT INTO durable_runtime_parent_wakes (
          wake_id, parent_run_id, parent_session_key, target_agent, target_session,
          target_channel, reason, facts_ref, source_run_id, dedupe_key, attempt_count,
          last_attempt_at, acked_at, failed_reason, status, created_at, updated_at,
          metadata_json
        )
        VALUES (
          'wake_legacy', NULL, 'agent:legacy:parent', NULL, NULL, NULL,
          'child_terminal', NULL, 'run_child', 'wake:legacy', 0,
          NULL, NULL, NULL, 'pending', 100, 100, NULL
        );
      `);
    } finally {
      db.close();
    }

    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      expect(store.getStats()).toMatchObject({
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(store.getParentWake("wake_legacy")).toMatchObject({
        wakeId: "wake_legacy",
        parentSessionKey: "agent:legacy:parent",
      });
      expect(
        store.createDurableWake({
          targetKind: "operator",
          targetRef: "operator:durable",
          ownerKind: "operator",
          ownerRef: "operator:durable",
          targetResolutionStatus: "inspect_only",
          targetResolutionReason: "no_handler_inspect_only",
          reason: "no_handler",
          dedupeKey: "wake:generalized-after-v2-migration",
          now: 200,
        }),
      ).toMatchObject({
        targetKind: "operator",
        targetRef: "operator:durable",
        targetResolutionStatus: "inspect_only",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records uncertainty facts, cleanup audit, dedupe evidence, and unresolved obligations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-store-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        runtimeRunId: "run_obligations",
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "claimed",
        now: 100,
      });
      store.claimNextRunnableRun({
        operationKind: "test.runtime",
        workerId: "worker-old",
        claimTtlMs: 10,
        now: 110,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "tool_1",
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 120,
      });
      store.claimNextRunnableStep({
        operationKind: "test.runtime",
        workerId: "worker-step",
        claimTtlMs: 10,
        now: 121,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "result_mailbox:child",
        stepType: "result_mailbox",
        status: "pending",
        recoveryState: "waiting_child",
        idempotencyKey: "result-mailbox:v1:child",
        now: 125,
      });
      const wake = store.createParentWake({
        parentRunId: run.runtimeRunId,
        reason: "delivery_unknown",
        factsRef: "channel:delivery:1",
        sourceRunId: run.runtimeRunId,
        dedupeKey: "wake:delivery:1",
        now: 130,
      });
      const fact = store.recordSideEffectUncertaintyFact({
        kind: "lost_after_dispatch",
        sourceRunId: run.runtimeRunId,
        stepId: step.stepId,
        factsRef: "tool:dispatch:1",
        dedupeKey: "uncertain:dispatch:1",
        facts: { providerRequestId: "req-1" },
        metadata: { preview: "redacted" },
        now: 140,
      });
      const duplicateFact = store.recordSideEffectUncertaintyFact({
        kind: "lost_after_dispatch",
        sourceRunId: run.runtimeRunId,
        dedupeKey: "uncertain:dispatch:1",
        now: 150,
      });
      expect(duplicateFact.factId).toBe(fact.factId);
      expect(store.listSideEffectUncertaintyFacts({ status: "open" })).toMatchObject([
        {
          factId: fact.factId,
          kind: "lost_after_dispatch",
          facts: { providerRequestId: "req-1" },
        },
      ]);

      const cleanup = store.recordContinuationCleanup({
        targetKind: "wake",
        targetId: wake.wakeId,
        runtimeRunId: run.runtimeRunId,
        supersededByRef: "event:newer-fact",
        reason: "newer fact superseded stale wake",
        requestedBy: "operator:test",
        dedupeKey: "cleanup:wake:1",
        now: 160,
      });
      expect(
        store.recordContinuationCleanup({
          targetKind: "wake",
          targetId: wake.wakeId,
          dedupeKey: "cleanup:wake:1",
          now: 170,
        }),
      ).toEqual(cleanup);
      expect(store.listContinuationCleanupAudit({ runtimeRunId: run.runtimeRunId })).toMatchObject([
        {
          cleanupId: cleanup.cleanupId,
          targetKind: "wake",
          status: "superseded",
        },
      ]);

      expect(
        store.recordDedupeLedgerEntry({
          scope: "recovery_pass",
          dedupeKey: "recovery:scan:1",
          subjectRef: run.runtimeRunId,
          operationKind: "test.runtime",
          now: 180,
        }),
      ).toMatchObject({ hitCount: 1, firstSeenAt: 180, lastSeenAt: 180 });
      expect(
        store.recordDedupeLedgerEntry({
          scope: "recovery_pass",
          dedupeKey: "recovery:scan:1",
          now: 190,
        }),
      ).toMatchObject({ hitCount: 2, firstSeenAt: 180, lastSeenAt: 190 });

      expect(
        store
          .listUnresolvedObligations({ now: 200 })
          .map((obligation) => [obligation.kind, obligation.status]),
      ).toEqual(
        expect.arrayContaining([
          ["pending_wake", "pending"],
          ["unresolved_uncertainty", "open"],
          ["expired_run_claim", "queued"],
          ["expired_step_claim", "queued"],
          ["pending_result_mailbox", "pending"],
        ]),
      );
      expect(
        store.resolveSideEffectUncertaintyFact({
          factId: fact.factId,
          status: "resolved",
          resolutionKind: "parent_ack",
          resolutionRef: wake.wakeId,
          now: 210,
        }),
      ).toMatchObject({
        status: "resolved",
        resolutionKind: "parent_ack",
        resolutionRef: wake.wakeId,
        resolvedAt: 210,
      });
      expect(store.listSideEffectUncertaintyFacts({ status: "open" })).toEqual([]);
      expect(store.getStats()).toMatchObject({
        pendingWakes: 1,
        unresolvedUncertaintyFacts: 0,
      });
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
      expect(durableTablesAfter.map((row) => row.name)).toEqual([...DURABLE_TABLES].toSorted());
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
