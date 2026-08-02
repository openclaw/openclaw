import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import { maybeRecordDurableGatewayStartup } from "./startup.js";

describe("durable gateway startup integration", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("records startup without reconciling open runs in observe mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-startup-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = { OPENCLAW_STATE_DIR: dir };
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    let runningRunId = "";
    try {
      const running = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        sourceOwner: "session_store",
        sourceRef: "agent:test:startup-inspection",
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

  it("reconciles open runs on startup in authority mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-startup-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = { OPENCLAW_STATE_DIR: dir };
    setRuntimeConfigSnapshot({ durable: { mode: "authority" } });
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    let runningRunId = "";
    try {
      const running = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        sourceOwner: "session_store",
        sourceRef: "agent:test:startup-worker",
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
