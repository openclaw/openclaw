// Verifies process-state persistence across fresh task registry module loads.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";

describe("task registry process state", () => {
  it("shares state across duplicate module instances", async () => {
    const firstModule = await importFreshModule<typeof import("./task-registry.process-state.js")>(
      import.meta.url,
      "./task-registry.process-state.js?scope=task-registry-state-a",
    );
    const secondModule = await importFreshModule<typeof import("./task-registry.process-state.js")>(
      import.meta.url,
      "./task-registry.process-state.js?scope=task-registry-state-b",
    );
    const firstState = firstModule.getTaskRegistryProcessState();
    const secondState = secondModule.getTaskRegistryProcessState();

    try {
      firstState.tasks.set("task-duplicate", {
        taskId: "task-duplicate",
        runtime: "subagent",
        taskKind: "agent-harness",
        requesterSessionKey: "agent:main:parent",
        ownerKey: "agent:main:parent",
        scopeKind: "session",
        runId: "agent-harness:child-duplicate",
        task: "Duplicate module task",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "silent",
        createdAt: 1,
      });

      expect(secondState.tasks.get("task-duplicate")).toEqual(
        expect.objectContaining({
          runtime: "subagent",
          taskKind: "agent-harness",
          runId: "agent-harness:child-duplicate",
        }),
      );
    } finally {
      firstState.tasks.delete("task-duplicate");
    }
  });

  it.each(["sync", "async"])(
    "retained readers preserve the selected %s runtime",
    async (restore) => {
      const firstRegistry = await import("./task-registry-query.js");
      const firstCreate = await import("./task-registry-create.native.js");
      firstRegistry.resetTaskRegistryForTests();

      vi.resetModules();

      const secondStore = await import("./task-registry.store.js");
      const secondRegistry = await import("./task-registry-query.js");
      const { createTaskRecord } = await import("./task-registry-create.native.js");
      const store = createInMemoryTaskRegistryStore();
      const loadSnapshot = vi.spyOn(store, "loadSnapshot");
      const onEvent = vi.fn();
      secondStore.configureTaskRegistryRuntime({ store, observers: { onEvent } });

      try {
        if (restore === "async") {
          const { ensureTaskRegistryReadyAsync } = await import("./task-registry-state.js");
          const { captureOpenClawStateWorkerContext } =
            await import("../state/openclaw-state-worker-context.js");
          await ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
        }
        const task = createTaskRecord({
          runtime: "subagent",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: "run-retained-registry-reader",
          task: "Keep the selected runtime across module reloads",
          status: "succeeded",
          deliveryStatus: "not_applicable",
        });
        expect(task).not.toBeNull();
        const loadsBeforeRetainedRead = loadSnapshot.mock.calls.length;
        expect(firstRegistry.findTaskByRunId("run-retained-registry-reader")?.taskId).toBe(
          task!.taskId,
        );
        expect(secondRegistry.getTaskById(task!.taskId)?.taskId).toBe(task!.taskId);
        expect(loadSnapshot).toHaveBeenCalledTimes(loadsBeforeRetainedRead);
        onEvent.mockClear();
        const retainedTask = firstCreate.createTaskRecord({
          runtime: "subagent",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          task: "Publish through the currently selected store and observer",
          status: "succeeded",
          deliveryStatus: "not_applicable",
        });
        expect(retainedTask).not.toBeNull();
        expect(store.loadSnapshot().tasks.has(retainedTask!.taskId)).toBe(true);
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "upserted",
            task: expect.objectContaining({ taskId: retainedTask!.taskId }),
          }),
        );
      } finally {
        firstRegistry.resetTaskRegistryForTests();
        secondRegistry.resetTaskRegistryForTests();
      }
    },
  );

  it("preserves task lifecycle observers without duplicating listeners across module loads", async () => {
    const events = await import("../infra/agent-events.js");
    const firstStore = await import("./task-registry.store.js");
    const onEvent = vi.fn();
    const store = {
      ...createInMemoryTaskRegistryStore(),
      loadSnapshot: () => ({ tasks: new Map(), deliveryStates: new Map() }),
    };
    firstStore.configureTaskRegistryRuntime({ store, observers: { onEvent } });
    const firstRegistry = await import("./task-registry.js");
    const firstQueries = await import("./task-registry-query.js");
    const firstListener = await import("./task-registry-listener-state.js");
    firstListener.resetTaskRegistryListenerState();
    events.resetAgentEventsForTest();
    firstRegistry.ensureTaskRegistryReady();

    vi.resetModules();

    const secondStore = await import("./task-registry.store.js");
    secondStore.configureTaskRegistryRuntime({ store });
    const secondRegistry = await import("./task-registry.js");
    const secondListener = await import("./task-registry-listener-state.js");

    try {
      secondRegistry.ensureTaskRegistryReady();
      const task = secondRegistry.createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:listener-reload",
        runId: "run-task-listener-reload",
        task: "Count tool events once",
        status: "running",
        deliveryStatus: "not_applicable",
      });
      expect(task).not.toBeNull();

      for (const name of ["read", "exec"]) {
        events.emitAgentEvent({
          runId: "run-task-listener-reload",
          stream: "tool",
          data: { phase: "start", name },
        });
      }

      expect(secondRegistry.getTaskById(task!.taskId)?.toolUseCount).toBe(2);
      expect(secondRegistry.getTaskById(task!.taskId)?.lastToolName).toBe("exec");
      secondRegistry.finalizeTaskRecordByRunId({
        runId: task!.runId!,
        runtime: "subagent",
        status: "succeeded",
        endedAt: Date.now(),
        terminalSummary: "Finished the delegated work.",
      });
      expect(secondRegistry.getTaskById(task!.taskId)?.status).toBe("succeeded");
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "upserted",
          task: expect.objectContaining({ taskId: task!.taskId, status: "succeeded" }),
        }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "upserted",
          task: expect.objectContaining({ taskId: task!.taskId, status: "running" }),
        }),
      );
    } finally {
      firstListener.resetTaskRegistryListenerState();
      secondListener.resetTaskRegistryListenerState();
      events.resetAgentEventsForTest();
      firstQueries.resetTaskRegistryForTests();
    }
  });
});
