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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { withPluginRegistrationContext } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  transitionTaskAssignment,
  getDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import { captureTaskExecutionOwner } from "../tasks/task-execution-owner.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/task-runtime.test-helpers.js";
import {
  AgentHarnessTaskAssignmentOwnerRetiredError,
  createAgentHarnessTaskRuntime,
  captureAgentHarnessTaskAssignment,
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
  transitionTaskAssignment: vi.fn((params) => {
    params.assertCurrent();
    return [];
  }),
  getDetachedTaskLifecycleRuntime: vi.fn(() => ({})),
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTaskRecords: vi.fn(() => []),
}));

vi.mock("../tasks/task-registry-read.js", () => ({
  captureTaskRegistryRunSelection: async (runId: string, matches: (task: TaskRecord) => boolean) =>
    structuredClone(listTaskRecords().filter((task) => task.runId === runId && matches(task))),
  prepareTaskRegistryRead: async () => ({
    getTasksByRunId: (runId: string) => listTaskRecords().filter((task) => task.runId === runId),
  }),
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

  it.each(["core", "custom", "legacy"] as const)(
    "checks exact-assignment support before admission with the %s runtime",
    (owner) => {
      const exactTransition = vi.fn(() => []);
      if (owner !== "core") {
        setDetachedTaskLifecycleRuntime({
          ...getDetachedTaskLifecycleRuntime(),
          ...(owner === "custom" ? { transitionTaskAssignment: exactTransition } : {}),
        });
      }
      try {
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-harness",
          scope: createScope(),
        });
        if (owner === "legacy") {
          expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
            "Upgrade the custom task runtime adapter",
          );
        } else {
          expect(() => runtime.assertTaskAssignmentSupported()).not.toThrow();
        }
        expect(createRunningTaskRun).not.toHaveBeenCalled();
        expect(exactTransition).not.toHaveBeenCalled();
        expect(transitionTaskAssignment).not.toHaveBeenCalled();
        // Legacy callers retain their unguarded operations without opting into exact settlement.
        runtime.createRunningTaskRun({ runId: "example:child", task: "work" });
        runtime.finalizeTaskRunByRunId({
          runId: "example:child",
          status: "succeeded",
          endedAt: 2,
        });
        expect(createRunningTaskRun).toHaveBeenCalledOnce();
        expect(finalizeTaskRunByRunId).toHaveBeenCalledOnce();
      } finally {
        if (owner !== "core") {
          resetDetachedTaskLifecycleRuntimeForTests();
        }
      }
    },
  );

  it.each(["core", "custom", "legacy"] as const)(
    "admits a scoped local registry with the %s task runtime before root activation",
    (owner) => {
      const registry = createEmptyPluginRegistry();
      try {
        withPluginRuntimeRegistryScope(registry, () => {
          if (owner !== "core") {
            setDetachedTaskLifecycleRuntime({
              ...getDetachedTaskLifecycleRuntime(),
              ...(owner === "custom" ? { transitionTaskAssignment: vi.fn(() => []) } : {}),
            });
          }
          const runtime = createAgentHarnessTaskRuntime({
            runtime: "subagent",
            taskKind: "example-harness",
            scope: createScope(),
          });
          if (owner === "legacy") {
            expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
              "Upgrade the custom task runtime adapter",
            );
          } else {
            expect(() => runtime.assertTaskAssignmentSupported()).not.toThrow();
          }
          markPluginRegistryRetired(registry);
          expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
            AgentHarnessTaskAssignmentOwnerRetiredError,
          );
        });
      } finally {
        markPluginRegistryRetired(registry);
      }
    },
  );

  it("does not admit an unpublished registration-only registry as a local runtime", () => {
    const registry = createEmptyPluginRegistry();
    try {
      withPluginRegistrationContext(registry, "fixture", () => {
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-harness",
          scope: createScope(),
        });
        expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
          AgentHarnessTaskAssignmentOwnerRetiredError,
        );
      });
    } finally {
      markPluginRegistryRetired(registry);
    }
  });

  it.each(["activation", "context replacement"] as const)(
    "does not transfer a scoped core task owner through %s",
    (change) => {
      const registry = createEmptyPluginRegistry();
      const replacement = createEmptyPluginRegistry();
      try {
        withPluginRuntimeRegistryScope(registry, () => {
          const runtime = createAgentHarnessTaskRuntime({
            runtime: "subagent",
            taskKind: "example-harness",
            scope: createScope(),
          });
          expect(() => runtime.assertTaskAssignmentSupported()).not.toThrow();
          const assertRetired = () =>
            expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
              AgentHarnessTaskAssignmentOwnerRetiredError,
            );
          if (change === "activation") {
            markPluginRegistryActive(registry);
            assertRetired();
          } else {
            withPluginRuntimeRegistryScope(replacement, assertRetired);
          }
        });
      } finally {
        markPluginRegistryRetired(registry);
        markPluginRegistryRetired(replacement);
      }
    },
  );

  it.each([false, true])(
    "projects private task content before every writer (private: %s)",
    (privateSession) => {
      const requesterSessionKey = privateSession
        ? "agent:main:dashboard:incognito-native"
        : "agent:main:main";
      const runtime = createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "example-harness",
        scope: createScope(requesterSessionKey),
      });
      const content = "SYNTHETIC_PRIVATE_TASK_CONTENT";
      const detail = { nativeTurnId: "turn-1", nativeHistory: { sessionId: "parent-1" } };
      const task = runtime.createRunningTaskRun({
        runId: "example:child",
        task: content,
        label: content,
        progressSummary: content,
        detail,
      });
      const expectedTask = captureAgentHarnessTaskAssignment(task);
      const created = vi.mocked(createRunningTaskRun).mock.calls[0]?.[0];
      expect(JSON.stringify(created).includes(content)).toBe(!privateSession);
      expect(created).toMatchObject({ requesterSessionKey, runId: "example:child", detail });

      for (const ownership of [{}, { expectedTask }]) {
        const identity = { runId: "example:child", ...ownership };
        runtime.recordTaskRunProgressByRunId({
          ...identity,
          progressSummary: content,
          eventSummary: content,
          detail,
        });
        runtime.finalizeTaskRunByRunId({
          ...identity,
          status: "failed",
          endedAt: 2,
          error: content,
          progressSummary: content,
          terminalSummary: content,
          detail,
        });
        runtime.setDetachedTaskDeliveryStatusByRunId({
          ...identity,
          deliveryStatus: "pending",
          error: content,
        });
      }
      for (const writer of [
        recordTaskRunProgressByRunId,
        finalizeTaskRunByRunId,
        setDetachedTaskDeliveryStatusByRunId,
      ]) {
        expect(JSON.stringify(vi.mocked(writer).mock.calls).includes(content)).toBe(
          !privateSession,
        );
        expect(writer).toHaveBeenCalledOnce();
      }
      const transitions = vi.mocked(transitionTaskAssignment).mock.calls.map(([input]) => input);
      expect(transitions).toHaveLength(3);
      expect(JSON.stringify(transitions).includes(content)).toBe(!privateSession);
      for (const transition of transitions) {
        expect(transition.expectedTask).toEqual(expectedTask);
        expect(transition.transition.params).toMatchObject({
          runId: "example:child",
          sessionKey: requesterSessionKey,
        });
      }
      expect(transitions[1]?.transition.params).toMatchObject({
        status: "failed",
        endedAt: 2,
        detail,
      });
    },
  );

  it("preserves the Incognito task cancellation marker", () => {
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope("agent:main:dashboard:incognito-native"),
    });
    runtime.finalizeTaskRunByRunId({
      runId: "example:child",
      status: "cancelled",
      endedAt: 2,
      error: SUBAGENT_KILL_TASK_ERROR,
    });
    expect(finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR }),
    );
  });

  it("keeps full Incognito completion content on the live delivery path", async () => {
    const result = "SYNTHETIC_LIVE_COMPLETION";
    await expect(
      deliverAgentHarnessTaskCompletion({
        scope: createScope("agent:main:dashboard:incognito-native"),
        childSessionKey: "harness-thread:child",
        childSessionId: "child",
        announceId: "harness:parent:child:succeeded",
        status: "succeeded",
        result,
      }),
    ).resolves.toMatchObject({ delivered: true, path: "steered" });
    expect(JSON.stringify(vi.mocked(deliverSubagentAnnouncement).mock.calls)).toContain(result);
  });

  it("keeps the runtime owner captured before an assignment's delayed settlement", () => {
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "example-harness",
      scope: createScope(),
    });
    expect(() => runtime.assertTaskAssignmentSupported()).not.toThrow();
    const task = runtime.createRunningTaskRun({ runId: "example:child", task: "work" });
    const expectedTask = captureAgentHarnessTaskAssignment(task);
    setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });
    try {
      expect(() => runtime.assertTaskAssignmentSupported()).toThrow(
        AgentHarnessTaskAssignmentOwnerRetiredError,
      );
      expect(() =>
        runtime.finalizeTaskRunByRunId({
          expectedTask,
          runId: task.runId!,
          status: "succeeded",
          endedAt: 2,
        }),
      ).toThrow(AgentHarnessTaskAssignmentOwnerRetiredError);
      expect(transitionTaskAssignment).toHaveBeenCalledOnce();
      expect(finalizeTaskRunByRunId).not.toHaveBeenCalled();
    } finally {
      resetDetachedTaskLifecycleRuntimeForTests();
    }
  });

  it.each(["replacement", "metadata"] as const)(
    "uses the original assignment receipt after pre-handoff %s",
    async (change) => {
      const task = {
        taskId: "original-task",
        runtime: "subagent" as const,
        taskKind: "example-harness",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session" as const,
        runId: "example:child",
        task: "work",
        status: "succeeded" as const,
        deliveryStatus: "pending" as const,
        notifyPolicy: "silent" as const,
        createdAt: 1,
      };
      const expectedTask = captureAgentHarnessTaskAssignment(task);
      vi.mocked(listTaskRecords).mockReturnValue([
        { ...task, ...(change === "replacement" ? { createdAt: 2 } : { label: "New metadata" }) },
      ]);
      const result = await deliverAgentHarnessTaskCompletion({
        scope: createScope("agent:main:main"),
        expectedTask,
        childSessionKey: task.runId,
        childSessionId: "child",
        announceId: "example:child:done",
        status: "succeeded",
        result: "Original result",
      });
      expect(result.delivered).toBe(change === "metadata");
      expect(deliverSubagentAnnouncement).toHaveBeenCalledTimes(change === "metadata" ? 1 : 0);
    },
  );

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
