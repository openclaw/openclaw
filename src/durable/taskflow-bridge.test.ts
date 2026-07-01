import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-runtime-internal.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import { syncDurableRunToTaskFlow } from "./taskflow-bridge.js";

describe("durable taskflow bridge", () => {
  beforeEach(() => {
    resetTaskFlowRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("projects waiting child durable state into TaskFlow state and wait metadata", () => {
    const flow = createManagedTaskFlow({
      controllerId: "durable-test",
      ownerKey: "agent:main:main",
      notifyPolicy: "state_changes",
      goal: "Coordinate children",
      status: "running",
    });
    expect(flow).toBeTruthy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-taskflow-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskFlowId: flow!.flowId,
          taskId: "task-parent",
          sessionKey: "agent:main:main",
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
        status: "running",
        recoveryState: "running",
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "running",
        now: 125,
      });

      const result = syncDurableRunToTaskFlow({
        store,
        runtimeRunId: parent.runtimeRunId,
      });

      expect(result).toMatchObject({
        synced: true,
        flowId: flow!.flowId,
        status: "waiting",
      });
      expect(getTaskFlowById(flow!.flowId)).toMatchObject({
        status: "waiting",
        currentStep: "subagents",
        stateJson: {
          durable: {
            runtimeRunId: parent.runtimeRunId,
            external: {
              taskId: "task-parent",
            },
            children: {
              total: 1,
              running: 1,
              open: 1,
            },
          },
        },
        waitJson: {
          durable: {
            waitingReason: "child",
            runtimeRunId: parent.runtimeRunId,
            stepId: "subagents",
          },
        },
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects terminal durable state into TaskFlow completion", () => {
    const flow = createManagedTaskFlow({
      controllerId: "durable-test",
      ownerKey: "agent:main:main",
      notifyPolicy: "state_changes",
      goal: "Complete durable work",
      status: "running",
    });
    expect(flow).toBeTruthy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-taskflow-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.task",
        status: "running",
        recoveryState: "running",
        metadata: { taskFlowId: flow!.flowId },
        now: 100,
      });
      store.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 150,
        now: 150,
      });

      const result = syncDurableRunToTaskFlow({
        store,
        runtimeRunId: run.runtimeRunId,
      });

      expect(result).toMatchObject({
        synced: true,
        status: "succeeded",
      });
      expect(getTaskFlowById(flow!.flowId)).toMatchObject({
        status: "succeeded",
        endedAt: 150,
        waitJson: null,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
