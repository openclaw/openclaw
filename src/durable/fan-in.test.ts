import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileDurableFanIn } from "./fan-in.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";

describe("durable workflow fan-in", () => {
  it("unblocks the parent when all children are terminal under continue policy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "workflows.sqlite"),
    });
    try {
      const parent = store.createRun({
        workflowId: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        workflowRunId: parent.workflowRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const childA = store.createRun({
        workflowId: "test.child",
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        status: "succeeded",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      const childB = store.createRun({
        workflowId: "test.child",
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        status: "failed",
        recoveryState: "terminal",
        completedAt: 130,
        now: 130,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        childWorkflowRunId: childA.workflowRunId,
        linkType: "child_workflow",
        status: "succeeded",
        now: 121,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        childWorkflowRunId: childB.workflowRunId,
        linkType: "child_workflow",
        status: "failed",
        now: 131,
      });

      const result = reconcileDurableFanIn({
        store,
        parentWorkflowRunId: parent.workflowRunId,
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
      expect(store.listSteps(parent.workflowRunId)).toMatchObject([
        {
          stepId: fanInStep.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          completedAt: 140,
        },
      ]);
      expect(store.listOpenRuns({ workflowId: "test.parent" })).toMatchObject([
        {
          workflowRunId: parent.workflowRunId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
      expect(store.getTimeline(parent.workflowRunId).at(-1)).toMatchObject({
        eventType: "fan_in.ready",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the parent when fail-parent policy sees a failed child", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-fanin-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "workflows.sqlite"),
    });
    try {
      const parent = store.createRun({
        workflowId: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        now: 100,
      });
      const fanInStep = store.createStep({
        workflowRunId: parent.workflowRunId,
        stepId: "fan_in_children",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 100,
      });
      const child = store.createRun({
        workflowId: "test.child",
        status: "failed",
        recoveryState: "terminal",
        completedAt: 120,
        now: 120,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        childWorkflowRunId: child.workflowRunId,
        linkType: "child_workflow",
        status: "failed",
        now: 121,
      });

      const result = reconcileDurableFanIn({
        store,
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: fanInStep.stepId,
        policy: "fail_parent_on_child_failure",
        now: 130,
      });

      expect(result.status).toBe("failed");
      expect(store.listRuns({ limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflowRunId: parent.workflowRunId,
            status: "failed",
            recoveryState: "terminal",
            completedAt: 130,
          }),
        ]),
      );
      expect(store.getTimeline(parent.workflowRunId).at(-1)).toMatchObject({
        eventType: "fan_in.failed",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
