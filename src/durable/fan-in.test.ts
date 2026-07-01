import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileDurableFanIn } from "./fan-in.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

describe("durable runtime fan-in", () => {
  it("unblocks the parent when all children are terminal under continue policy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const childA = store.createRun({
        operationKind: "test.child",
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      const childB = store.createRun({
        operationKind: "test.child",
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        status: "failed",
        recoveryState: "terminal",
        completedAt: 130,
        now: 130,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: childA.runtimeRunId,
        linkType: "child_runtime",
        status: "succeeded",
        now: 121,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: childB.runtimeRunId,
        linkType: "child_runtime",
        status: "failed",
        now: 131,
      });

      const result = reconcileDurableFanIn({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        policy: "continue_on_child_failure",
        now: 140,
      });

      expect(result).toEqual({
        status: "succeeded",
        total: 2,
        succeeded: 1,
        failed: 1,
        terminal: 2,
        ready: true,
      });
      expect(store.listSteps(parent.runtimeRunId)).toMatchObject([
        {
          stepId: fanInStep.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          completedAt: 140,
        },
      ]);
      expect(store.listOpenRuns({ operationKind: "test.parent" })).toMatchObject([
        {
          runtimeRunId: parent.runtimeRunId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
      expect(store.getTimeline(parent.runtimeRunId).at(-1)).toMatchObject({
        eventType: "fan_in.ready",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the parent when fail-parent policy sees a failed child", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const child = store.createRun({
        operationKind: "test.child",
        status: "failed",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: child.runtimeRunId,
        linkType: "child_runtime",
        status: "failed",
        now: 121,
      });

      const result = reconcileDurableFanIn({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        policy: "fail_parent_on_child_failure",
        now: 130,
      });

      expect(result.status).toBe("failed");
      expect(store.listRuns({ limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeRunId: parent.runtimeRunId,
            status: "failed",
            recoveryState: "terminal",
            completedAt: 130,
          }),
        ]),
      );
      expect(store.getTimeline(parent.runtimeRunId).at(-1)).toMatchObject({
        eventType: "fan_in.failed",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves detailed child terminal outcomes in fan-in metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const child = store.createRun({
        operationKind: "test.child",
        status: "failed",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: child.runtimeRunId,
        linkType: "child_runtime",
        status: "failed",
        metadata: { terminalOutcome: "overflowed" },
        now: 121,
      });

      const result = reconcileDurableFanIn({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        policy: "continue_on_child_failure",
        now: 130,
      });

      expect(result).toMatchObject({
        status: "succeeded",
        total: 1,
        succeeded: 0,
        failed: 1,
        terminal: 1,
        ready: true,
      });
      expect(store.listSteps(parent.runtimeRunId)[0]?.metadata).toMatchObject({
        outcomes: { overflowed: 1 },
      });
      expect(store.getTimeline(parent.runtimeRunId).at(-1)?.payload).toMatchObject({
        outcomes: { overflowed: 1 },
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens a completed fan-in step when a new child is linked later", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const firstChild = store.createRun({
        operationKind: "test.child",
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: firstChild.runtimeRunId,
        linkType: "child_runtime",
        status: "succeeded",
        now: 121,
      });

      expect(
        reconcileDurableFanIn({
          store,
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId: fanInStep.stepId,
          policy: "continue_on_child_failure",
          now: 130,
        }).status,
      ).toBe("succeeded");
      const laterChild = store.createRun({
        operationKind: "test.child",
        status: "running",
        recoveryState: "running",
        now: 140,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        childRuntimeRunId: laterChild.runtimeRunId,
        linkType: "child_runtime",
        status: "running",
        now: 141,
      });

      const result = reconcileDurableFanIn({
        store,
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: fanInStep.stepId,
        policy: "continue_on_child_failure",
        now: 150,
      });

      expect(result).toEqual({
        status: "waiting",
        total: 2,
        succeeded: 1,
        failed: 0,
        terminal: 1,
        ready: false,
      });
      const reopenedStep = store.listSteps(parent.runtimeRunId)[0];
      expect(reopenedStep).toMatchObject({
        stepId: fanInStep.stepId,
        status: "waiting",
        recoveryState: "waiting_child",
      });
      expect(reopenedStep?.completedAt).toBeUndefined();
      const reopenedParent = store.listOpenRuns({ operationKind: "test.parent" })[0];
      expect(reopenedParent).toMatchObject({
        runtimeRunId: parent.runtimeRunId,
        status: "waiting_child",
        recoveryState: "waiting_child",
      });
      expect(reopenedParent?.completedAt).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
