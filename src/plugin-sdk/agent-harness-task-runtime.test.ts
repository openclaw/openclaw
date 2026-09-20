/**
 * Tests agent harness task runtime scope, persistence, and completion delivery.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverSubagentAnnouncement,
  isInternalAnnounceRequesterSession,
} from "../agents/subagents/announce/subagent-announce-delivery.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "../agents/subagents/announce/subagent-announce-origin.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../tasks/detached-task-runtime.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import { captureTaskExecutionOwner } from "../tasks/task-execution-owner.js";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
} from "./agent-harness-task-runtime.js";

vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../agents/subagents/announce/subagent-announce-delivery.js")
    >();
  return {
    ...actual,
    deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "steered" })),
    isInternalAnnounceRequesterSession: vi.fn(() => true),
    loadRequesterSessionEntry: vi.fn((requesterSessionKey: string) => ({
      cfg: {},
      canonicalKey: requesterSessionKey,
      agentId: "main",
    })),
  };
});

vi.mock("../agents/subagents/announce/subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: vi.fn(() => undefined),
  resolveSubagentCompletionOrigin: vi.fn(async () => undefined),
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: vi.fn((params) => ({ taskId: "task-1", ...params })),
  recordTaskRunProgressByRunId: vi.fn(() => []),
  finalizeTaskRunByRunId: vi.fn(() => []),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTaskRecords: vi.fn(() => []),
}));

vi.mock("../tasks/task-execution-owner.js", () => ({
  captureTaskExecutionOwner: vi.fn(),
}));

describe("agent-harness-task-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTaskRecords).mockReturnValue([]);
    vi.mocked(isInternalAnnounceRequesterSession).mockReturnValue(true);
    vi.mocked(resolveAnnounceOrigin).mockReset();
    vi.mocked(resolveSubagentCompletionOrigin).mockReset();
  });

  function createScope(requesterSessionKey = "agent:main:channel:C123") {
    return createAgentHarnessTaskRuntimeScope({ requesterSessionKey });
  }

  it("records the scoped harness process identity without recapturing a reused PID", () => {
    const executionOwner = { host: "gateway-host", pid: 4321, startIdentity: 100 };
    vi.mocked(captureTaskExecutionOwner).mockReturnValue(executionOwner);
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope(),
      executionPid: executionOwner.pid,
    });
    vi.mocked(captureTaskExecutionOwner).mockReturnValue({
      ...executionOwner,
      startIdentity: 200,
    });

    for (const runId of ["child-1", "child-2"]) {
      const task = runtime.createRunningTaskRun({ runId, task: "do work" });
      expect(task.executionOwner).toEqual(executionOwner);
    }
    expect(captureTaskExecutionOwner).toHaveBeenCalledExactlyOnceWith(executionOwner.pid);
  });

  it("keeps an unidentified or remote harness owner unknown", () => {
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope(),
    });
    const task = runtime.createRunningTaskRun({ runId: "child-1", task: "remote work" });

    expect(task.executionOwner).toBeUndefined();
    expect(captureTaskExecutionOwner).not.toHaveBeenCalled();
  });

  it.each([undefined, "task-child-1"])(
    "scopes lifecycle mutations and forwards task selector %s",
    (taskId) => {
      const runtime = createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "example-harness",
        scope: createScope(),
        runIdPrefix: "example:",
      });

      runtime.createRunningTaskRun({
        runId: "example:child-1",
        sourceId: "example:child-1",
        task: "do work",
        label: "worker",
      });
      runtime.finalizeTaskRunByRunId({
        ...(taskId !== undefined ? { taskId } : {}),
        runId: "example:child-1",
        status: "succeeded",
        endedAt: 1,
      });
      runtime.recordTaskRunProgressByRunId({
        ...(taskId !== undefined ? { taskId } : {}),
        runId: "example:child-1",
        progressSummary: "working",
      });

      expect(createRunningTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: "subagent",
          taskKind: "example-harness",
          requesterSessionKey: "agent:main:channel:C123",
          ownerKey: "agent:main:channel:C123",
          scopeKind: "session",
          runId: "example:child-1",
        }),
      );
      expect(finalizeTaskRunByRunId).toHaveBeenCalledWith(
        expect.objectContaining({
          ...(taskId !== undefined ? { taskId } : {}),
          runtime: "subagent",
          sessionKey: "agent:main:channel:C123",
          runId: "example:child-1",
        }),
      );
      expect(recordTaskRunProgressByRunId).toHaveBeenCalledWith({
        ...(taskId !== undefined ? { taskId } : {}),
        runtime: "subagent",
        sessionKey: "agent:main:channel:C123",
        runId: "example:child-1",
        progressSummary: "working",
      });
    },
  );

  it("rejects task run ids outside the configured harness scope", () => {
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope(),
      runIdPrefix: "example:",
    });

    expect(() =>
      runtime.finalizeTaskRunByRunId({
        runId: "other:child-1",
        status: "succeeded",
        endedAt: 1,
      }),
    ).toThrow(/outside the configured scope/);
  });

  it("rejects caller-forged task runtime scopes", async () => {
    const forgedScope = {
      requesterSessionKey: "agent:other:channel:C999",
    } as ReturnType<typeof createScope>;
    expect(() =>
      createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "example-harness",
        scope: forgedScope,
      }),
    ).toThrow(/host-issued scope/);
    await expect(
      deliverAgentHarnessTaskCompletion({
        scope: forgedScope,
        childSessionKey: "harness-thread:child",
        childSessionId: "child",
        announceId: "harness:parent:child:succeeded",
        status: "succeeded",
        result: "child final answer",
      }),
    ).rejects.toThrow(/host-issued scope/);
  });

  it("lists only task records owned by the scoped requester session", () => {
    const records = [
      {
        taskId: "task-1",
        runtime: "subagent",
        taskKind: "example-harness",
        requesterSessionKey: "agent:main:channel:C123",
        ownerKey: "agent:main:channel:C123",
        scopeKind: "session",
        runId: "example:child-1",
        task: "owned",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      },
      {
        taskId: "task-2",
        runtime: "subagent",
        taskKind: "example-harness",
        requesterSessionKey: "agent:other:channel:C999",
        ownerKey: "agent:other:channel:C999",
        scopeKind: "session",
        runId: "example:child-2",
        task: "other",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      },
    ] satisfies ReturnType<typeof listTaskRecords>;
    vi.mocked(listTaskRecords).mockImplementation((filter) =>
      filter ? records.filter(filter) : records,
    );
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope(),
      runIdPrefix: "example:",
    });

    expect(runtime.listTaskRecords().map((task) => task.taskId)).toEqual(["task-1"]);
  });

  it.each(["unguarded", "retired-during-origin"] as const)(
    "delivers a generic harness completion with source admission %s",
    async (sourceAdmission) => {
      const gatewayContextResolver = vi.fn();
      const requesterOrigin = { channel: "discord", to: "channel:C123" };
      const originEntered = createDeferredCore();
      const releaseOrigin = createDeferredCore();
      let admissionAllowed = true;
      if (sourceAdmission === "retired-during-origin") {
        vi.mocked(isInternalAnnounceRequesterSession).mockReturnValueOnce(false);
        vi.mocked(resolveAnnounceOrigin).mockReturnValueOnce(requesterOrigin);
        vi.mocked(resolveSubagentCompletionOrigin).mockImplementationOnce(
          async ({ requesterOrigin: resolvedOrigin }) => {
            originEntered.resolve();
            await releaseOrigin.promise;
            return resolvedOrigin;
          },
        );
      }
      vi.mocked(deliverSubagentAnnouncement).mockImplementationOnce(async (params) => {
        expect(getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext).toBe(
          gatewayContextResolver,
        );
        if (sourceAdmission === "retired-during-origin") {
          expect(params.isSourceSessionAdmissionAllowed?.()).toBe(false);
          const actual = await vi.importActual<
            typeof import("../agents/subagents/announce/subagent-announce-delivery.js")
          >("../agents/subagents/announce/subagent-announce-delivery.js");
          return actual.deliverSubagentAnnouncement(params);
        }
        return { delivered: true, path: "steered" };
      });
      const delivery = deliverAgentHarnessTaskCompletion({
        scope: createAgentHarnessTaskRuntimeScope({
          requesterSessionKey: "agent:main:main",
          gatewayContextResolver,
          ...(sourceAdmission === "retired-during-origin" ? { requesterOrigin } : {}),
        }),
        childSessionKey: "harness-thread:child",
        childSessionId: "child",
        announceId: "harness:parent:child:succeeded",
        announceType: "Example harness worker",
        taskLabel: "Example worker",
        status: "succeeded",
        statusLabel: "task_complete",
        result: "child final answer",
        ...(sourceAdmission === "retired-during-origin"
          ? { isSourceSessionAdmissionAllowed: () => admissionAllowed }
          : {}),
      });
      try {
        if (sourceAdmission === "retired-during-origin") {
          await Promise.race([
            originEntered.promise,
            delivery.then(() => {
              throw new Error("Completion settled before origin resolution");
            }),
          ]);
          expect(deliverSubagentAnnouncement).not.toHaveBeenCalled();
          admissionAllowed = false;
          releaseOrigin.resolve();
          await expect(delivery).resolves.toMatchObject({
            delivered: false,
            reason: "source_owner_changed",
            terminal: true,
          });
        } else {
          await expect(delivery).resolves.toMatchObject({ delivered: true, path: "steered" });
        }
        expect(deliverSubagentAnnouncement).toHaveBeenCalledWith(
          expect.objectContaining({
            requesterSessionKey: "agent:main:main",
            sourceSessionKey: "harness-thread:child",
            sourceTool: "agent_harness_task",
            expectsCompletionMessage: true,
            directIdempotencyKey: "announce:harness:parent:child:succeeded",
          }),
        );
        expect(vi.mocked(deliverSubagentAnnouncement).mock.calls[0]?.[0]).not.toHaveProperty(
          "resolveGatewayContext",
        );
      } finally {
        releaseOrigin.resolve();
        await delivery;
      }
    },
  );

  it("rechecks the captured task during an asynchronous announcement", async () => {
    const task = {
      taskId: "native-task",
      runtime: "subagent" as const,
      taskKind: "example-harness",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session" as const,
      runId: "example:child-1",
      sourceId: "example:child-1",
      task: "work",
      status: "succeeded" as "succeeded" | "cancelled",
      deliveryStatus: "pending" as const,
      notifyPolicy: "silent" as const,
      createdAt: 1,
    };
    vi.mocked(listTaskRecords).mockReturnValue([task]);
    vi.mocked(deliverSubagentAnnouncement).mockImplementationOnce(async (params) => {
      expect(params.isSourceSessionEffectsAllowed?.()).toBe(true);
      await Promise.resolve();
      task.status = "cancelled";
      expect(params.isSourceSessionEffectsAllowed?.()).toBe(false);
      return { delivered: false, path: "none" };
    });
    await expect(
      deliverAgentHarnessTaskCompletion({
        scope: createScope("agent:main:main"),
        childSessionKey: task.runId,
        childSessionId: "child-1",
        announceId: "example:parent:child:succeeded",
        status: "succeeded",
        result: "result",
      }),
    ).resolves.toMatchObject({ delivered: false });
  });

  it.each(["replace", "remove", "insert", "unchanged"] as const)(
    "binds completion task before origin lookup: %s",
    async (change) => {
      const task = {
        taskId: "native-task",
        runtime: "subagent" as const,
        taskKind: "example-harness",
        requesterSessionKey: "agent:main:channel:C123",
        ownerKey: "agent:main:channel:C123",
        scopeKind: "session" as const,
        runId: "example:child-1",
        task: "work",
        status: "succeeded" as const,
        deliveryStatus: "pending" as const,
        notifyPolicy: "silent" as const,
        createdAt: 1,
      };
      const origin = { channel: "discord", to: "channel:C123" };
      vi.mocked(listTaskRecords).mockReturnValue(change === "insert" ? [] : [task]);
      vi.mocked(isInternalAnnounceRequesterSession).mockReturnValue(false);
      vi.mocked(resolveAnnounceOrigin).mockReturnValue(origin);
      vi.mocked(resolveSubagentCompletionOrigin).mockImplementationOnce(async () => {
        await Promise.resolve();
        if (change !== "unchanged") {
          vi.mocked(listTaskRecords).mockReturnValue(
            change === "remove" ? [] : [{ ...task, taskId: "replacement-task" }],
          );
        }
        return origin;
      });
      if (change === "unchanged") {
        vi.mocked(deliverSubagentAnnouncement).mockImplementationOnce(async (params) => ({
          delivered: params.isSourceSessionEffectsAllowed?.() === true,
          path: "steered",
        }));
      }
      const result = await deliverAgentHarnessTaskCompletion({
        scope: createScope(),
        childSessionKey: task.runId,
        childSessionId: "child-1",
        announceId: "example:parent:child:succeeded",
        status: "succeeded",
        result: "result",
      });
      expect(resolveSubagentCompletionOrigin).toHaveBeenCalledOnce();
      if (change === "unchanged") {
        expect(result.delivered).toBe(true);
      } else {
        expect(result).toMatchObject({ delivered: false, recoveryBlocked: true });
        expect(deliverSubagentAnnouncement).not.toHaveBeenCalled();
      }
    },
  );

  it("checks durable direct delivery phases", () => {
    expect(
      isDurableAgentHarnessCompletionDelivery({
        delivered: true,
        path: "direct",
        phases: [{ phase: "direct-primary", delivered: true, path: "direct" }],
      }),
    ).toBe(true);
    expect(
      isDurableAgentHarnessCompletionDelivery({
        delivered: true,
        path: "direct",
        phases: [{ phase: "steer-fallback", delivered: true, path: "steered" }],
      }),
    ).toBe(false);
  });
});
