// Verifies process-state persistence across fresh task registry module loads.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

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
    firstState.tasks.clear();
  });

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
      firstStore.resetTaskRegistryRuntimeForTests();
      secondStore.resetTaskRegistryRuntimeForTests();
    }
  });

  it("keeps published rows when a stale module instance restores from its own store", async () => {
    // Non-isolated workers reset the module graph per file while timers and promise
    // chains from an earlier file keep their old module instance alive. Its late
    // readiness check must not replace rows the live instance published.
    const tasks = new Map<string, TaskRecord>(
      ["task-a", "task-b", "task-c"].map((taskId, index) => [
        taskId,
        {
          taskId,
          runtime: "cli",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: `run-${taskId}`,
          task: `Task ${index}`,
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "done_only",
          createdAt: index + 1,
          lastEventAt: index + 1,
        } satisfies TaskRecord,
      ]),
    );
    await withTestDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const liveStore = await import("./task-registry.store.js");
        const liveRegistry = await import("./task-registry.js");
        resetTaskRegistryForTests({ persist: false });
        // Both instances must observe one open database identity, as a running Gateway does.
        openOpenClawStateDatabase();
        liveStore.configureTaskRegistryRuntime({
          store: createInMemoryTaskRegistryStore({ tasks, deliveryStates: new Map() }),
        });
        const expected = liveRegistry.listTaskRecords().map((task) => task.taskId);
        expect(expected).toHaveLength(tasks.size);

        vi.resetModules();
        const staleRegistry = await import("./task-registry.js");
        const staleStore = await import("./task-registry.store.js");
        try {
          staleRegistry.ensureTaskRegistryReady();
          expect(liveRegistry.listTaskRecords().map((task) => task.taskId)).toEqual(expected);
          expect(staleRegistry.listTaskRecords().map((task) => task.taskId)).toEqual(expected);
        } finally {
          resetTaskRegistryForTests({ persist: false });
          liveStore.resetTaskRegistryRuntimeForTests();
          staleStore.resetTaskRegistryRuntimeForTests();
        }
      });
    });
  });
});
