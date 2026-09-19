// Shared task executor state, runtime mocks, and record fixtures.
import { expect, vi } from "vitest";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { captureEnv } from "../test-utils/env.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { getTaskById } from "./runtime-internal.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "./task-backing-authority.test-support.js";
import {
  createQueuedTaskRunCore as createQueuedTaskRunOrNull,
  createRunningTaskRunCore as createRunningTaskRunOrNull,
  runTaskInFlowForOwner,
} from "./task-executor.js";
import { hoisted } from "./task-executor.mocks.test-support.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { createManagedTaskFlow as createManagedTaskFlowOrNull } from "./task-flow-runtime-internal.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
  setDetachedTaskLifecycleRuntime,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-runtime.test-helpers.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

export function createQueuedTaskRun(
  params: Parameters<typeof createQueuedTaskRunOrNull>[0],
): TaskRecord {
  const task = createQueuedTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected queued task creation to succeed");
  }
  return task;
}

export function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const detail =
    params.detail ??
    (params.runtime === "acp"
      ? createAcpTaskBackingDetailForTest(`instance:${params.runId ?? "unknown"}`)
      : params.runtime === "subagent"
        ? createSubagentTaskBackingDetail(1)
        : undefined);
  const task = createRunningTaskRunOrNull({
    ...params,
    ...(detail !== undefined ? { detail } : {}),
  });
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

export function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

export function runTaskInFlow(
  params: Omit<Parameters<typeof runTaskInFlowForOwner>[0], "callerOwnerKey">,
) {
  return runTaskInFlowForOwner({
    ...params,
    callerOwnerKey: "agent:main:main",
  });
}
export async function withTaskExecutorStateDir(
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  await withStateDirEnv("openclaw-task-executor-", async ({ stateDir }) => {
    resetDetachedTaskLifecycleRuntimeForTests();
    resetSystemEventsForTest();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryControlRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => ({
        cancelSession: hoisted.cancelSessionMock,
      }),
      killSubagentRunAdmin: async (params) => {
        const result = await hoisted.killSubagentRunAdminMock(params);
        params.onResult?.(result);
        return result;
      },
    });
    try {
      await run(stateDir);
    } finally {
      resetSystemEventsForTest();
      resetAgentEventsForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

export function expectParentFlowId(task: { parentFlowId?: string }): string {
  expect(task.parentFlowId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  if (task.parentFlowId === undefined) {
    throw new Error("Expected task parent flow id");
  }
  return task.parentFlowId;
}

export function requireCreatedFlowTask(
  result: ReturnType<typeof runTaskInFlow>,
): NonNullable<ReturnType<typeof runTaskInFlow>["task"]> {
  if (!result.task) {
    throw new Error("Expected TaskFlow child task to be created");
  }
  return result.task;
}

export function expectCancelRequestedAt(value: unknown): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error("Expected numeric cancelRequestedAt");
  }
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
  return value;
}

export function createRunningAcpChildTaskRun(
  overrides: Partial<Parameters<typeof createRunningTaskRun>[0]> = {},
) {
  return createRunningTaskRun({
    runtime: "acp",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:child",
    runId: "run-acp-child",
    task: "Inspect a PR",
    startedAt: 10,
    deliveryStatus: "pending",
    ...overrides,
  });
}

export function spyOnRuntimeCancel() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const cancelDetachedTaskRunByIdSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.cancelDetachedTaskRunById>) =>
      defaultRuntime.cancelDetachedTaskRunById(...args),
  );

  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
  });

  return cancelDetachedTaskRunByIdSpy;
}

export function expectCancelledAcpChildTask(
  child: ReturnType<typeof createRunningTaskRun>,
  cancelled: { found?: boolean; cancelled?: boolean },
) {
  expect(cancelled.found).toBe(true);
  expect(cancelled.cancelled).toBe(true);
  const task = getTaskById(child.taskId);
  expect(task?.taskId).toBe(child.taskId);
  expect(task?.status).toBe("cancelled");
  expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
    cfg: {} as never,
    sessionKey: "agent:codex:acp:child",
    agentId: "codex",
    reason: "task-cancel",
    expectedRunId: child.runId,
    expectedInstanceId: `instance:${child.runId}`,
  });
}

export function resetTaskExecutorTestState() {
  ORIGINAL_ENV.restore();
  resetSystemEventsForTest();
  resetAgentEventsForTest();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  hoisted.sendMessageMock.mockReset();
  hoisted.cancelSessionMock.mockReset();
  hoisted.killSubagentRunAdminMock.mockReset();
}

export { hoisted };
