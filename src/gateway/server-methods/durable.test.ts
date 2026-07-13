import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDurableRuntimeSqlitePath } from "../../durable/config.js";
import { openDurableRuntimeSqliteStore } from "../../durable/sqlite-store.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db.js";
import { durableHandlers } from "./durable.js";

describe("durable gateway methods", () => {
  it("returns coordination projection for a durable runtime run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskId: "task-parent",
          taskFlowId: "flow-parent",
          sessionKey: "agent:bo:main",
        },
        now: 100,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 110,
      });
      const child = store.createRun({
        operationKind: "test.child",
        status: "succeeded",
        recoveryState: "terminal",
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "succeeded",
        now: 130,
      });
      store.close();
      storeClosed = true;

      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: parent.runtimeRunId },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(true);
      expect(calls[0]?.[1]).toMatchObject({
        projection: {
          runtimeRunId: parent.runtimeRunId,
          waitingReason: "child",
          currentStepId: "subagents",
          external: {
            taskId: "task-parent",
            taskFlowId: "flow-parent",
            sessionKey: "agent:bo:main",
          },
          children: {
            total: 1,
            succeeded: 1,
            terminal: 1,
            open: 0,
          },
        },
      });
    } finally {
      if (!storeClosed) {
        store.close();
      }
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create durable state when the feature is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-disabled-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_DURABLE_RUNTIME;
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "rt_disabled" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("responds with a safe error for a future shared state schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-future-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const sqlitePath = resolveDurableRuntimeSqlitePath(process.env);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }

    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "rt_future" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(calls[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("newer schema version"),
      });
      const verifyDb = new DatabaseSync(sqlitePath);
      try {
        expect(
          verifyDb
            .prepare(
              `SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND name LIKE 'durable_runtime_%'
                 ORDER BY name`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        verifyDb.close();
      }
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid coordination params before opening durable state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-invalid-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "", includeSteps: true },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists, inspects, and controls durable wake obligations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-wakes-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      store.createDurableWake({
        wakeId: "wake_gateway_ack",
        targetKind: "operator",
        targetRef: "operator:oncall",
        ownerKind: "operator",
        ownerRef: "operator:oncall",
        targetResolutionStatus: "resolved",
        reason: "delivery_unknown",
        factsRef: "facts:gateway",
        sourceRunId: "run_gateway_source",
        dedupeKey: "wake:gateway:ack",
        metadata: { diagnostics: { route: "operator" }, evidence: { source: "test" } },
        now: 100,
      });
      store.recordWakeDeliveryAttempt({
        deliveryAttemptId: "attempt_gateway_ack",
        wakeId: "wake_gateway_ack",
        dedupeKey: "attempt:gateway:ack",
        routeKind: "operator",
        routeRef: "operator:oncall",
        status: "failed",
        error: "route unavailable",
        now: 110,
      });
      store.recordSideEffectUncertaintyFact({
        factId: "fact_gateway_ack",
        kind: "delivery_unknown",
        sourceRunId: "run_gateway_source",
        factsRef: "facts:gateway",
        dedupeKey: "fact:gateway:ack",
        now: 120,
      });
      store.createDurableWake({
        wakeId: "wake_gateway_supersede",
        targetKind: "operator",
        targetRef: "operator:oncall",
        ownerKind: "operator",
        ownerRef: "operator:oncall",
        reportRouteRef: "operator:oncall",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "operator_route",
        reason: "operator_requested",
        dedupeKey: "wake:gateway:supersede",
        now: 130,
      });
      store.createDurableWake({
        wakeId: "wake_gateway_mark",
        targetKind: "operator",
        targetRef: "operator:oncall",
        ownerKind: "operator",
        ownerRef: "operator:oncall",
        reportRouteRef: "operator:oncall",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "operator_route",
        reason: "operator_requested",
        dedupeKey: "wake:gateway:mark",
        now: 140,
      });
      store.close();
      storeClosed = true;

      const calls: unknown[][] = [];
      const call = (method: string, params: Record<string, unknown>) => {
        void durableHandlers[method]?.({
          params,
          respond: (...args: unknown[]) => calls.push([method, ...args]),
        } as never);
      };

      call("durable.wake.list", { limit: 10 });
      expect(calls.at(-1)?.[1]).toBe(true);
      expect(calls.at(-1)?.[2]).toMatchObject({
        wakes: [
          { wakeId: "wake_gateway_mark" },
          { wakeId: "wake_gateway_supersede" },
          { wakeId: "wake_gateway_ack" },
        ],
      });

      call("durable.wake.inspect", { wakeId: "wake_gateway_ack" });
      expect(calls.at(-1)?.[1]).toBe(true);
      expect(calls.at(-1)?.[2]).toMatchObject({
        inspection: {
          targetResolution: {
            diagnostics: { route: "operator" },
            evidence: { source: "test" },
          },
          deliveryAttempts: [{ deliveryAttemptId: "attempt_gateway_ack", status: "failed" }],
          unresolvedUncertaintyFacts: [{ factId: "fact_gateway_ack", status: "open" }],
        },
      });

      call("durable.wake.acknowledge", {
        wakeId: "wake_gateway_ack",
        actorKind: "operator",
        actorRef: "operator:oncall",
        reason: "operator reviewed failed attempt",
        idempotencyKey: "gateway:ack:1",
        evidence: { ticket: "GW-1" },
      });
      expect(calls.at(-1)?.[1]).toBe(true);
      expect(calls.at(-1)?.[2]).toMatchObject({
        wake: {
          wakeId: "wake_gateway_ack",
          status: "acked",
          metadata: { durableWakeControls: [{ kind: "acknowledged" }] },
        },
      });

      call("durable.wake.supersede", {
        wakeId: "wake_gateway_supersede",
        actorKind: "external",
        actorRef: "ticket:GW-2",
        reason: "stale route replaced",
        idempotencyKey: "gateway:supersede:1",
        supersededByRef: "wake:replacement",
      });
      expect(calls.at(-1)?.[1]).toBe(true);
      expect(calls.at(-1)?.[2]).toMatchObject({
        wake: { wakeId: "wake_gateway_supersede", status: "superseded" },
      });

      call("durable.wake.mark", {
        wakeId: "wake_gateway_mark",
        actorKind: "operator",
        actorRef: "operator:oncall",
        reason: "requires explicit owner decision",
        idempotencyKey: "gateway:mark:1",
        decisionKind: "requires_human_decision",
      });
      expect(calls.at(-1)?.[1]).toBe(true);
      expect(calls.at(-1)?.[2]).toMatchObject({
        wake: {
          wakeId: "wake_gateway_mark",
          status: "pending",
          metadata: { durableWakeControls: [{ kind: "requires_human_decision" }] },
        },
      });
    } finally {
      if (!storeClosed) {
        store.close();
      }
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid durable wake control params before opening durable state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-invalid-wake-control-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      void durableHandlers["durable.wake.acknowledge"]?.({
        params: {
          wakeId: "wake_invalid",
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "missing idempotency",
        },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
