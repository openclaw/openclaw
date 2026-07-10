import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import { maybeRecordDurableGatewayStartup } from "./startup.js";

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
});
