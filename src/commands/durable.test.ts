import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveDurableRuntimeSqlitePath } from "../durable/config.js";
import { buildDurableFanInGroupId } from "../durable/fan-in.js";
import { openDurableRuntimeStore } from "../durable/store-factory.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { durableCommand } from "./durable.js";

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: vi.fn(),
  };
  return { errors, logs, runtime };
}

describe("durableCommand", () => {
  it("does not create or migrate durable state when the runtime is disabled", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-disabled-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    const candidates = resolveSqliteDatabaseFilePaths(sqlitePath);
    const { errors, logs, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env }, runtime);

      expect(errors).toEqual([]);
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(logs).toEqual([
        "Durable runtime is disabled. Set OPENCLAW_DURABLE_RUNTIME=1 to inspect durable runtime state.",
      ]);
      for (const candidate of candidates) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not migrate an existing shared state database when the runtime is disabled", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-disabled-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE schema_meta (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO schema_meta (key, value) VALUES ('openclaw_state_schema_version', 'legacy');
      `);
    } finally {
      db.close();
    }
    const { errors, logs, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env }, runtime);

      expect(errors).toEqual([]);
      expect(logs).toEqual([
        "Durable runtime is disabled. Set OPENCLAW_DURABLE_RUNTIME=1 to inspect durable runtime state.",
      ]);
      const verifyDb = new DatabaseSync(sqlitePath);
      try {
        expect(
          verifyDb
            .prepare(
              `SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND (name = 'durable_schema_migrations' OR name LIKE 'durable_runtime_%')`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        verifyDb.close();
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a safe error for enabled inspection of a future shared state schema", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-future-"));
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DURABLE_RUNTIME: "1" };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }
    const { errors, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env }, runtime);

      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(errors[0]).toContain("Durable runtime store unavailable");
      expect(errors[0]).toContain("newer schema version");
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
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports disabled status as JSON without creating durable state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-disabled-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sqlitePath = resolveDurableRuntimeSqlitePath(env);
    const { logs, runtime } = createRuntimeCapture();

    try {
      await durableCommand({ action: "stats", env, json: true }, runtime);

      expect(JSON.parse(logs[0] ?? "{}")).toEqual({ enabled: false });
      for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
        expect(fs.existsSync(candidate)).toBe(false);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("explains why a run is waiting on child work", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-why-"));
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };
    const runtimeRunId = (() => {
      const store = openDurableRuntimeStore({ env });
      try {
        const parent = store.createRun({
          operationKind: "test.parent",
          status: "waiting_child",
          recoveryState: "waiting_child",
          sourceRef: "agent:test:main",
          now: 100,
        });
        store.createStep({
          runtimeRunId: parent.runtimeRunId,
          stepId: "children",
          stepType: "fan_in",
          status: "waiting",
          recoveryState: "waiting_child",
          now: 100,
        });
        const child = store.createRun({
          operationKind: "test.child",
          status: "running",
          recoveryState: "running",
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId: "children",
          now: 110,
        });
        store.createLink({
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId: "children",
          childRuntimeRunId: child.runtimeRunId,
          linkType: "subagent",
          status: "running",
          now: 110,
        });
        return parent.runtimeRunId;
      } finally {
        store.close();
      }
    })();

    try {
      const { logs, runtime } = createRuntimeCapture();

      await durableCommand({ action: "why", runtimeRunId, env }, runtime);

      expect(logs[0]).toContain("Summary: Run is waiting for child work: 1 open of 1 children.");
      expect(logs[0]).toContain("Waiting reason: child");
      expect(logs[0]).toContain("Children: total=1 open=1 terminal=0");
      expect(logs[0]).toContain(`- openclaw durable children ${runtimeRunId}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("renders fan-in group and result mailbox diagnostics in show output", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-show-"));
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };
    const runtimeRunId = (() => {
      const store = openDurableRuntimeStore({ env });
      try {
        const parent = store.createRun({
          operationKind: "test.parent",
          status: "waiting_child",
          recoveryState: "waiting_child",
          sourceRef: "agent:test:main",
          now: 100,
        });
        const parentStepId = "children";
        const fanInGroupId = buildDurableFanInGroupId({
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId,
        });
        store.createStep({
          runtimeRunId: parent.runtimeRunId,
          stepId: parentStepId,
          stepType: "fan_in",
          status: "waiting",
          recoveryState: "waiting_child",
          metadata: { fanInGroupId },
          now: 100,
        });
        const child = store.createRun({
          operationKind: "test.child",
          status: "succeeded",
          recoveryState: "terminal",
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId,
          now: 110,
        });
        store.createLink({
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId,
          childRuntimeRunId: child.runtimeRunId,
          linkType: "subagent",
          status: "succeeded",
          metadata: { fanInGroupId, childSessionKey: "agent:test:subagent:child" },
          now: 110,
        });
        store.createStep({
          runtimeRunId: parent.runtimeRunId,
          stepId: `result_mailbox:${child.runtimeRunId}`,
          parentStepId,
          stepType: "result_mailbox",
          status: "queued",
          recoveryState: "runnable",
          metadata: {
            outcome: { terminalOutcome: "succeeded" },
            ack: { status: "pending" },
            delivery: { status: "attempted" },
          },
          now: 120,
        });
        return parent.runtimeRunId;
      } finally {
        store.close();
      }
    })();

    try {
      const { logs, runtime } = createRuntimeCapture();

      await durableCommand({ action: "show", runtimeRunId, env }, runtime);

      expect(logs[0]).toContain("fan_in=");
      expect(logs[0]).toContain("session=agent:test:subagent:child");
      expect(logs[0]).toContain("outcome=succeeded");
      expect(logs[0]).toContain("ack=pending");
      expect(logs[0]).toContain("delivery=attempted");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces recovery diagnostics in the why command", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-why-"));
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };
    const runtimeRunId = (() => {
      const store = openDurableRuntimeStore({ env });
      try {
        return store.createRun({
          operationKind: "test.agent_turn",
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
          metadata: {
            recoveryDiagnostic: {
              state: "lost",
              severity: "error",
              reason: "stale_heartbeat",
              message: "Agent turn was marked lost during durable recovery.",
              nextAction: "inspect_timeline_then_retry_or_resume",
              safeRecoveryActions: ["inspect_timeline", "retry_request"],
            },
          },
          now: 200,
        }).runtimeRunId;
      } finally {
        store.close();
      }
    })();

    try {
      const { logs, runtime } = createRuntimeCapture();

      await durableCommand({ action: "why", runtimeRunId, env }, runtime);

      expect(logs[0]).toContain("Summary: Agent turn was marked lost during durable recovery.");
      expect(logs[0]).toContain("Recovery: lost/error next=inspect_timeline_then_retry_or_resume");
      expect(logs[0]).toContain("Reason: stale_heartbeat");
      expect(logs[0]).toContain("Safe actions: inspect_timeline, retry_request");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("lists and inspects durable wake obligations with delivery attempts and diagnostics", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-wakes-"));
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };
    const wakeId = (() => {
      const store = openDurableRuntimeStore({ env });
      try {
        const wake = store.createDurableWake({
          wakeId: "wake_cli_inspect",
          targetKind: "agent_session",
          targetRef: "agent:main:session",
          ownerKind: "agent_session",
          ownerRef: "agent:main:session",
          targetResolutionStatus: "resolved",
          reason: "delivery_unknown",
          factsRef: "facts:cli",
          sourceRunId: "run_cli_source",
          dedupeKey: "wake:cli:inspect",
          metadata: {
            diagnostics: { route: "owner-route" },
            evidence: { source: "unit-test" },
          },
          now: 100,
        });
        store.recordWakeDeliveryAttempt({
          deliveryAttemptId: "attempt_cli_inspect",
          wakeId: wake.wakeId,
          dedupeKey: "attempt:cli:inspect",
          routeKind: "agent_session",
          routeRef: "agent:main:session",
          status: "unknown",
          evidence: { delivery: "unknown" },
          now: 120,
        });
        store.recordSideEffectUncertaintyFact({
          factId: "fact_cli_inspect",
          kind: "delivery_unknown",
          sourceRunId: "run_cli_source",
          factsRef: "facts:cli",
          dedupeKey: "fact:cli:inspect",
          facts: { delivery: "unknown" },
          now: 130,
        });
        return wake.wakeId;
      } finally {
        store.close();
      }
    })();

    try {
      const listCapture = createRuntimeCapture();
      await durableCommand({ action: "wakes", env, json: true }, listCapture.runtime);
      expect(JSON.parse(listCapture.logs[0] ?? "[]")).toMatchObject([
        { wakeId, status: "pending", targetResolutionStatus: "resolved" },
      ]);

      const inspectCapture = createRuntimeCapture();
      await durableCommand({ action: "wake", wakeId, env, json: true }, inspectCapture.runtime);
      expect(JSON.parse(inspectCapture.logs[0] ?? "{}")).toMatchObject({
        wake: { wakeId },
        targetResolution: {
          diagnostics: { route: "owner-route" },
          evidence: { source: "unit-test" },
        },
        deliveryAttempts: [{ deliveryAttemptId: "attempt_cli_inspect", status: "unknown" }],
        unresolvedUncertaintyFacts: [{ factId: "fact_cli_inspect", status: "open" }],
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("records audited durable wake controls and rejects missing control args", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-cli-controls-"));
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DURABLE_RUNTIME: "1",
    };
    const store = openDurableRuntimeStore({ env });
    try {
      store.createDurableWake({
        wakeId: "wake_cli_ack",
        targetKind: "operator",
        targetRef: "operator:cli-controls",
        ownerKind: "operator",
        ownerRef: "operator:cli-controls",
        reportRouteRef: "operator:cli-controls",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "operator_route",
        reason: "operator_requested",
        dedupeKey: "wake:cli:ack",
        now: 100,
      });
      store.createDurableWake({
        wakeId: "wake_cli_mark",
        targetKind: "operator",
        targetRef: "operator:cli-controls",
        ownerKind: "operator",
        ownerRef: "operator:cli-controls",
        reportRouteRef: "operator:cli-controls",
        targetResolutionStatus: "resolved",
        targetResolutionReason: "operator_route",
        reason: "operator_requested",
        dedupeKey: "wake:cli:mark",
        now: 100,
      });
      store.close();

      const ackCapture = createRuntimeCapture();
      await durableCommand(
        {
          action: "wake-ack",
          wakeId: "wake_cli_ack",
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "operator confirmed delivery",
          idempotencyKey: "ack:cli:1",
          evidence: { ticket: "T-1" },
          env,
          json: true,
        },
        ackCapture.runtime,
      );
      expect(JSON.parse(ackCapture.logs[0] ?? "{}")).toMatchObject({
        wakeId: "wake_cli_ack",
        status: "acked",
        metadata: {
          durableWakeControls: [
            {
              kind: "acknowledged",
              actorKind: "operator",
              actorRef: "operator:test",
              idempotencyKey: "ack:cli:1",
            },
          ],
        },
      });

      const markCapture = createRuntimeCapture();
      await durableCommand(
        {
          action: "wake-mark",
          wakeId: "wake_cli_mark",
          actorKind: "external",
          actorRef: "ticket:T-2",
          reason: "needs owner choice",
          idempotencyKey: "mark:cli:1",
          decisionKind: "requires_operator_decision",
          env,
          json: true,
        },
        markCapture.runtime,
      );
      expect(JSON.parse(markCapture.logs[0] ?? "{}")).toMatchObject({
        wakeId: "wake_cli_mark",
        status: "pending",
        metadata: {
          durableWakeControls: [{ kind: "requires_operator_decision" }],
        },
      });

      const invalidCapture = createRuntimeCapture();
      await durableCommand(
        {
          action: "wake-supersede",
          wakeId: "wake_cli_mark",
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "missing idempotency key",
          env,
        },
        invalidCapture.runtime,
      );
      expect(invalidCapture.runtime.exit).toHaveBeenCalledWith(1);
      expect(invalidCapture.errors).toContain("--idempotency-key is required.");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
