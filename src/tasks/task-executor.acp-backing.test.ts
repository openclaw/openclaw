// ACP task backing, execution identity, and cancellation boundaries.
import "./task-executor.mocks.test-support.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpTaskBackingDetailForTest } from "./task-backing-authority.test-support.js";
import {
  cancelFlowById,
  cancelDetachedTaskRunById,
  completeTaskRunByRunIdCore as completeTaskRunByRunId,
  createRunningTaskRunCore as createRunningTaskRunOrNull,
  failTaskRunByRunIdCore as failTaskRunByRunId,
  recordTaskRunProgressByRunIdCore as recordTaskRunProgressByRunId,
} from "./task-executor.js";
import {
  createRunningTaskRun,
  createManagedTaskFlow,
  runTaskInFlow,
  requireCreatedFlowTask,
  withTaskExecutorStateDir,
  hoisted,
  createRunningAcpChildTaskRun,
  expectCancelledAcpChildTask,
  resetTaskExecutorTestState,
} from "./task-executor.test-support.js";
import { getTaskFlowById } from "./task-flow-registry.js";
import { getTaskById, findTaskByRunId, markTaskTerminalById } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

describe("task-executor", () => {
  afterEach(resetTaskExecutorTestState);

  it("does not let a managed flow cancel another owner's backing run", async () => {
    await withTaskExecutorStateDir(async () => {
      const backing = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:victim",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:victim-child",
        runId: "run-foreign-child",
        task: "Victim task",
        startedAt: 10,
      });
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });
      const linked = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:acp:victim-child",
        runId: "run-foreign-child",
        task: "Forged projection",
        startedAt: 10,
        detail: {
          ...createAcpTaskBackingDetailForTest("instance:run-foreign-child"),
          taskId: backing.taskId,
        },
      });
      expect(linked.parentFlowId).toBe(flow.flowId);

      const cancelled = await cancelFlowById({ cfg: {} as never, flowId: flow.flowId });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: "Child task ownership could not be verified; no cancellation was performed.",
      });
      expect(getTaskFlowById(flow.flowId)?.cancelRequestedAt).toBeUndefined();
      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningAcpChildTaskRun({
        runId: "run-linear-cancel",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expectCancelledAcpChildTask(child, cancelled);
    });
  });

  it("does not deliver backing lifecycle updates to a foreign managed projection", async () => {
    await withTaskExecutorStateDir(async () => {
      const backing = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:victim",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:victim-child",
        runId: "run-shared-child",
        task: "Victim ACP task",
        deliveryStatus: "pending",
      });
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/foreign-projection",
        goal: "Foreign projection",
      });
      const projection = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:acp:victim-child",
        runId: "run-shared-child",
        task: "Forged projection",
        detail: {
          ...createAcpTaskBackingDetailForTest("instance:run-shared-child"),
          taskId: backing.taskId,
        },
      });

      failTaskRunByRunId({
        runId: "run-shared-child",
        runtime: "acp",
        sessionKey: "agent:main:acp:victim-child",
        endedAt: 40,
        error: "victim failure",
      });

      expect(getTaskById(backing.taskId)?.status).toBe("failed");
      expect(getTaskById(projection.taskId)?.status).toBe("running");
    });
  });

  it("scopes ACP lifecycle writes to the selected task and its current managed projections", async () => {
    await withTaskExecutorStateDir(async () => {
      const common = {
        runtime: "acp" as const,
        ownerKey: "agent:main:main",
        scopeKind: "session" as const,
        childSessionKey: "agent:main:acp:shared-child",
        runId: "run-shared-instance",
        task: "Identical request",
        deliveryStatus: "pending" as const,
      };
      const first = createRunningTaskRun({
        ...common,
        detail: createAcpTaskBackingDetailForTest("instance-first", 1),
      });
      const flow = createManagedTaskFlow({
        ownerKey: common.ownerKey,
        controllerId: "tests/selected-acp",
        goal: "Track exact execution",
      });
      const project = () =>
        requireCreatedFlowTask(
          runTaskInFlow({
            flowId: flow.flowId,
            runtime: "acp",
            childSessionKey: common.childSessionKey,
            runId: common.runId,
            task: common.task,
            status: "running",
          }),
        );
      const firstProjection = project();
      const scope = {
        runtime: "acp" as const,
        sessionKey: common.childSessionKey,
        runId: common.runId,
      };
      recordTaskRunProgressByRunId({
        ...scope,
        taskId: first.taskId,
        progressSummary: "first output",
      });
      expect(getTaskById(firstProjection.taskId)?.progressSummary).toBe("first output");

      const second = createRunningTaskRun({
        ...common,
        detail: createAcpTaskBackingDetailForTest("instance-second", 2),
      });
      const secondProjection = project();
      expect(secondProjection.taskId).not.toBe(firstProjection.taskId);
      const staleProjection = getTaskById(firstProjection.taskId);
      const runningSecond = getTaskById(second.taskId);
      for (const wrongScope of [
        { runId: "other-run" },
        { runtime: "cli" as const },
        { sessionKey: "agent:other:main" },
        { taskId: "missing-task" },
      ]) {
        expect(
          failTaskRunByRunId({
            ...scope,
            taskId: second.taskId,
            ...wrongScope,
            endedAt: 100,
          }),
        ).toEqual([]);
      }
      expect(getTaskById(second.taskId)).toEqual(runningSecond);
      failTaskRunByRunId({
        ...scope,
        taskId: first.taskId,
        endedAt: 200,
        error: "late predecessor failure",
      });
      expect(getTaskById(first.taskId)?.status).toBe("failed");
      expect(getTaskById(second.taskId)).toEqual(runningSecond);
      expect(getTaskById(firstProjection.taskId)).toEqual(staleProjection);
      recordTaskRunProgressByRunId({
        ...scope,
        taskId: second.taskId,
        progressSummary: "second output",
      });
      completeTaskRunByRunId({ ...scope, taskId: second.taskId, endedAt: 300 });
      expect(getTaskById(second.taskId)?.status).toBe("succeeded");
      expect(getTaskById(secondProjection.taskId)).toMatchObject({
        status: "succeeded",
        progressSummary: "second output",
        endedAt: 300,
      });
      expect(getTaskById(firstProjection.taskId)).toEqual(staleProjection);
    });
  });

  it("refuses ACP cancellation without instance backing while preserving older exact-task settlement", async () => {
    await withTaskExecutorStateDir(async () => {
      const common = {
        runtime: "acp" as const,
        ownerKey: "agent:main:former-owner",
        scopeKind: "session" as const,
        childSessionKey: "agent:main:acp:legacy-child",
        runId: "reused-legacy-run",
        task: "Legacy ACP task",
      };
      const legacy = createRunningTaskRunOrNull(common);
      if (!legacy) {
        throw new Error("Expected the legacy ACP task.");
      }
      const current = createRunningTaskRun({ ...common, ownerKey: "agent:main:current-owner" });
      expect(
        await cancelDetachedTaskRunById({ cfg: {} as never, taskId: legacy.taskId }),
      ).toMatchObject({
        found: true,
        cancelled: false,
        reason:
          "ACP task execution cannot be verified. Select its current task or use ACP session controls.",
      });
      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
      expect(getTaskById(current.taskId)).toEqual(current);
      completeTaskRunByRunId({
        runtime: "acp",
        runId: common.runId,
        sessionKey: common.childSessionKey,
        taskId: legacy.taskId,
        endedAt: Date.now(),
      });
      expect(getTaskById(legacy.taskId)?.status).toBe("succeeded");
      expect(getTaskById(current.taskId)).toEqual(current);
    });
  });

  it.each(["older-first", "newer-first"] as const)(
    "looks up the current ACP instance across owner adoption and legacy records (%s)",
    async (order) => {
      await withTaskExecutorStateDir(async () => {
        const common = {
          runtime: "acp" as const,
          scopeKind: "session" as const,
          ownerKey: "agent:main:former-owner",
          childSessionKey: "agent:main:acp:adopted-child",
          runId: "run-adopted-lookup",
          task: "ACP lookup",
          deliveryStatus: "pending" as const,
        };
        const legacy = createRunningTaskRunOrNull(common);
        if (!legacy) {
          throw new Error("Expected the legacy ACP task");
        }
        const createOlder = () =>
          createRunningTaskRun({
            ...common,
            detail: createAcpTaskBackingDetailForTest("older-instance", 1),
          });
        const createNewer = () =>
          createRunningTaskRun({
            ...common,
            ownerKey: "agent:main:current-owner",
            detail: createAcpTaskBackingDetailForTest("newer-instance", 2),
          });
        let older: TaskRecord;
        let newer: TaskRecord;
        if (order === "older-first") {
          older = createOlder();
          newer = createNewer();
        } else {
          newer = createNewer();
          older = createOlder();
        }
        markTaskTerminalById({ taskId: older.taskId, status: "cancelled", endedAt: 100 });
        expect(findTaskByRunId(common.runId)?.taskId).toBe(newer.taskId);
        expect(getTaskById(legacy.taskId)?.detail).toBeUndefined();
        expect(getTaskById(older.taskId)).toMatchObject({
          status: "cancelled",
          detail: { instanceId: "older-instance", generation: 1 },
        });
      });
    },
  );

  it("preserves lookup priority across runtimes and distinct physical ACP sessions", async () => {
    await withTaskExecutorStateDir(async () => {
      const common = {
        scopeKind: "session" as const,
        childSessionKey: "shared-session",
        runId: "run-shared-lookup",
        task: "Scoped lookup",
        deliveryStatus: "pending" as const,
      };
      createRunningTaskRun({
        ...common,
        runtime: "cli",
        ownerKey: "agent:main:main",
        agentId: "main",
      });
      const otherAgent = createRunningTaskRun({
        ...common,
        runtime: "acp",
        ownerKey: "agent:other:main",
        agentId: "other",
        detail: createAcpTaskBackingDetailForTest("other-agent", 1),
      });
      createRunningTaskRun({
        ...common,
        runtime: "acp",
        ownerKey: "agent:main:main",
        agentId: "main",
        detail: createAcpTaskBackingDetailForTest("main-old", 2),
      });
      createRunningTaskRun({
        ...common,
        runtime: "acp",
        ownerKey: "agent:main:main",
        agentId: "main",
        detail: createAcpTaskBackingDetailForTest("main-new", 3),
      });
      expect(findTaskByRunId(common.runId)?.taskId).toBe(otherAgent.taskId);
    });
  });
});
