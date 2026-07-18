import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import { maybeRecordDurableGatewayStartup } from "./startup.js";
import { recordDurableWakeObligation } from "./wake-producers.js";

describe("durable gateway startup integration", () => {
  it("records startup without reconciling open runs unless the worker flag is explicit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-startup-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    let runningRunId = "";
    try {
      const running = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      setupStore.createStep({
        runtimeRunId: running.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      runningRunId = running.runtimeRunId;
    } finally {
      setupStore.close();
    }

    try {
      await maybeRecordDurableGatewayStartup({
        processInstanceId: "process-inspection-only",
        startupStartedAt: 200,
        env,
      });

      const verifyStore = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        expect(verifyStore.getRun(runningRunId)).toMatchObject({
          status: "running",
          recoveryState: "running",
        });
        expect(verifyStore.listSteps(runningRunId)).toMatchObject([
          {
            stepId: "agent_invocation",
            status: "running",
            recoveryState: "running",
          },
        ]);
        expect(
          verifyStore
            .listRuns({ limit: 10 })
            .some((run) => run.operationKind === "openclaw.gateway.startup"),
        ).toBe(true);
      } finally {
        verifyStore.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles open runs on startup when the worker flag is explicit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-startup-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_DURABLE_WORKER: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    let runningRunId = "";
    try {
      const running = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      setupStore.createStep({
        runtimeRunId: running.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      runningRunId = running.runtimeRunId;
    } finally {
      setupStore.close();
    }

    try {
      await maybeRecordDurableGatewayStartup({
        processInstanceId: "process-worker-enabled",
        startupStartedAt: 200,
        env,
      });

      const verifyStore = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        expect(verifyStore.getRun(runningRunId)).toMatchObject({
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
        });
        expect(verifyStore.listSteps(runningRunId)).toMatchObject([
          {
            stepId: "agent_invocation",
            status: "lost",
            recoveryState: "lost",
            completedAt: 200,
          },
        ]);
      } finally {
        verifyStore.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays pending wake obligations into the internal session delivery queue", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-startup-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    let wakeId = "";
    try {
      const wake = recordDurableWakeObligation({
        store: setupStore,
        reason: "child_terminal",
        dedupeKey: "wake:test:startup-internal-delivery",
        sourceRunId: "run_child_startup",
        factsRef: "facts:startup-internal-delivery",
        facts: {
          sourceRunId: "run_child_startup",
          delegations: [
            {
              kind: "subagent_child",
              parent: {
                kind: "agent_session",
                ref: "agent:main:main",
                ownerKind: "agent_session",
                ownerRef: "agent:main:main",
                reportRouteRef: "discord:thread:startup",
              },
            },
          ],
        },
        evidence: { kind: "startup_internal_delivery_test" },
        now: 100,
      });
      wakeId = wake.wakeId;
    } finally {
      setupStore.close();
    }

    try {
      await maybeRecordDurableGatewayStartup({
        processInstanceId: "process-internal-delivery",
        startupStartedAt: 200,
        env,
      });
      await maybeRecordDurableGatewayStartup({
        processInstanceId: "process-internal-delivery-repeat",
        startupStartedAt: 300,
        env,
      });

      const queued = await loadPendingSessionDeliveries(dir);
      expect(queued).toEqual([
        expect.objectContaining({
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: expect.stringContaining(`wakeId=${wakeId}`),
        }),
      ]);

      const verifyStore = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        expect(verifyStore.listWakeDeliveryAttempts({ wakeId })).toEqual([
          expect.objectContaining({
            replayPassId: "gateway-startup:process-internal-delivery:200",
            status: "delivered",
            evidence: expect.objectContaining({
              kind: "wake_internal_session_delivery_enqueued",
              internalDelivery: "session_delivery_queue",
              noExternalSend: true,
            }),
          }),
        ]);
      } finally {
        verifyStore.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
