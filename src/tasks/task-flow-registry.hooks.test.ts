import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  isTaskFlowCreatedEvent,
  isTaskFlowDeletedEvent,
  isTaskFlowTransitionEvent,
  registerInternalHook,
  type InternalHookEvent,
} from "../hooks/internal-hooks.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createFlowRecord,
  createManagedTaskFlow,
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  failFlow,
  finishFlow,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  syncFlowFromTask,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-flow-hooks-" },
    async (state) => {
      resetTaskFlowRegistryForTests();
      try {
        return await run(state.stateDir);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry hook events", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearInternalHooks();
    resetTaskFlowRegistryForTests();
  });

  // =========================================================================
  // Hook events (task:flow:created, task:flow:transition, task:flow:deleted)
  // =========================================================================

  it("emits task:flow:created hook when a managed flow is created", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const hookEvents: InternalHookEvent[] = [];
      registerInternalHook("task:flow:created", (event) => {
        hookEvents.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/hooks",
        goal: "Test hook creation",
        tags: { env: "test", priority: "high" },
      });

      // Wait for fire-and-forget hooks to settle.
      await vi.waitFor(() => expect(hookEvents).toHaveLength(1));

      const event = hookEvents[0];
      expect(event.type).toBe("task");
      expect(event.action).toBe("flow:created");
      expect(event.sessionKey).toBe("agent:main:main");

      const context = event.context as { flow: Record<string, unknown> };
      expect(context.flow.flowId).toBe(created.flowId);
      expect(context.flow.syncMode).toBe("managed");
      expect(context.flow.status).toBe("queued");
      expect(context.flow.goal).toBe("Test hook creation");
      expect(context.flow.tags).toEqual({ env: "test", priority: "high" });
    });
  });

  it("emits task:flow:transition hook on status changes", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const transitionEvents: InternalHookEvent[] = [];
      registerInternalHook("task:flow:transition", (event) => {
        transitionEvents.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/hooks",
        goal: "Lifecycle transitions",
        tags: { workflow: "deploy" },
      });

      resumeFlow({
        flowId: created.flowId,
        expectedRevision: 0,
        status: "running",
      });

      finishFlow({
        flowId: created.flowId,
        expectedRevision: 1,
      });

      await vi.waitFor(() => expect(transitionEvents).toHaveLength(2));

      const runningTransition = transitionEvents[0];
      const ctx0 = runningTransition.context as {
        flow: Record<string, unknown>;
        previousStatus: string;
        durationMs: number;
      };
      expect(ctx0.previousStatus).toBe("queued");
      expect(ctx0.flow.status).toBe("running");
      expect(ctx0.flow.tags).toEqual({ workflow: "deploy" });
      expect(ctx0.durationMs).toBeGreaterThanOrEqual(0);

      const succeededTransition = transitionEvents[1];
      const ctx1 = succeededTransition.context as {
        flow: Record<string, unknown>;
        previousStatus: string;
      };
      expect(ctx1.previousStatus).toBe("running");
      expect(ctx1.flow.status).toBe("succeeded");
    });
  });

  it("emits task:flow:deleted hook when a flow is deleted", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const deletedEvents: InternalHookEvent[] = [];
      registerInternalHook("task:flow:deleted", (event) => {
        deletedEvents.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/hooks",
        goal: "Test deletion",
        tags: { env: "staging" },
      });

      deleteTaskFlowRecordById(created.flowId);

      await vi.waitFor(() => expect(deletedEvents).toHaveLength(1));

      const event = deletedEvents[0];
      expect(event.type).toBe("task");
      expect(event.action).toBe("flow:deleted");

      const context = event.context as {
        flowId: string;
        previous: Record<string, unknown>;
      };
      expect(context.flowId).toBe(created.flowId);
      expect(context.previous.goal).toBe("Test deletion");
      expect(context.previous.tags).toEqual({ env: "staging" });
    });
  });

  it("does not emit transition hook when status stays the same", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const transitionEvents: InternalHookEvent[] = [];
      registerInternalHook("task:flow:transition", (event) => {
        transitionEvents.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/hooks",
        goal: "Same status update",
      });

      // Update stateJson without changing status — should NOT trigger transition.
      setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: 0,
        stateJson: { phase: "waiting" },
      });

      // The waiting status IS a change from queued, so one transition is expected.
      await vi.waitFor(() => expect(transitionEvents).toHaveLength(1));

      // Now update within waiting — no transition.
      setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: 1,
        stateJson: { phase: "still-waiting" },
      });

      // Give hooks time to settle — no extra transition should appear.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transitionEvents).toHaveLength(1);
    });
  });

  it("emits hook for failure transitions with tags propagated", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const transitions: InternalHookEvent[] = [];
      registerInternalHook("task:flow:transition", (event) => {
        transitions.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/hooks",
        goal: "Failure path",
        tags: { pipeline: "ci" },
      });

      failFlow({
        flowId: created.flowId,
        expectedRevision: 0,
        blockedSummary: "Runner crashed.",
      });

      await vi.waitFor(() => expect(transitions).toHaveLength(1));

      const ctx = transitions[0].context as {
        flow: Record<string, unknown>;
        previousStatus: string;
      };
      expect(ctx.flow.status).toBe("failed");
      expect(ctx.previousStatus).toBe("queued");
      expect(ctx.flow.tags).toEqual({ pipeline: "ci" });
    });
  });

  // =========================================================================
  // Diagnostic event bus bridge
  // =========================================================================

  it("emits task.flow.created diagnostic event on flow creation", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "task.flow.created") {
          diagnosticEvents.push(event);
        }
      });

      try {
        createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/diag",
          goal: "Diagnostic test",
          tags: { env: "test" },
        });

        expect(diagnosticEvents).toHaveLength(1);
        const evt = diagnosticEvents[0];
        expect(evt.type).toBe("task.flow.created");
        if (evt.type !== "task.flow.created") {
          throw new Error("Wrong type");
        }
        expect(evt.syncMode).toBe("managed");
        expect(evt.ownerKey).toBe("agent:main:main");
        expect(evt.goal).toBe("Diagnostic test");
        expect(evt.tags).toEqual({ env: "test" });
      } finally {
        unsubscribe();
      }
    });
  });

  it("emits task.flow.transition diagnostic events through full lifecycle", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const transitions: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "task.flow.transition") {
          transitions.push(event);
        }
      });

      try {
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/diag",
          goal: "Full lifecycle",
          tags: { team: "platform" },
        });

        resumeFlow({
          flowId: flow.flowId,
          expectedRevision: 0,
          status: "running",
        });

        finishFlow({
          flowId: flow.flowId,
          expectedRevision: 1,
        });

        expect(transitions).toHaveLength(2);

        const running = transitions[0];
        if (running.type !== "task.flow.transition") {
          throw new Error("Wrong type");
        }
        expect(running.previousStatus).toBe("queued");
        expect(running.status).toBe("running");
        expect(running.tags).toEqual({ team: "platform" });
        expect(running.durationMs).toBeGreaterThanOrEqual(0);

        const succeeded = transitions[1];
        if (succeeded.type !== "task.flow.transition") {
          throw new Error("Wrong type");
        }
        expect(succeeded.previousStatus).toBe("running");
        expect(succeeded.status).toBe("succeeded");
      } finally {
        unsubscribe();
      }
    });
  });

  it("emits task.flow.deleted diagnostic event on deletion", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const deletedEvents: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "task.flow.deleted") {
          deletedEvents.push(event);
        }
      });

      try {
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/diag",
          goal: "Delete diag",
          tags: { env: "prod" },
        });

        deleteTaskFlowRecordById(flow.flowId);

        expect(deletedEvents).toHaveLength(1);
        const evt = deletedEvents[0];
        if (evt.type !== "task.flow.deleted") {
          throw new Error("Wrong type");
        }
        expect(evt.flowId).toBe(flow.flowId);
        expect(evt.ownerKey).toBe("agent:main:main");
        expect(evt.previousStatus).toBe("queued");
        expect(evt.tags).toEqual({ env: "prod" });
      } finally {
        unsubscribe();
      }
    });
  });

  // =========================================================================
  // Tags field
  // =========================================================================

  it("persists tags on TaskFlowRecord through create", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tags",
        goal: "Tag persistence",
        tags: { env: "test", service: "api", priority: "p1" },
      });

      expect(created.tags).toEqual({ env: "test", service: "api", priority: "p1" });

      // Verify getTaskFlowById returns the same tags from the in-memory store.
      const { getTaskFlowById } = await import("./task-flow-registry.js");
      const fetched = getTaskFlowById(created.flowId);
      expect(fetched?.tags).toEqual({ env: "test", service: "api", priority: "p1" });
    });
  });

  it("creates flows without tags when none are provided", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/no-tags",
        goal: "No tags flow",
      });

      expect(created.tags).toBeUndefined();
    });
  });

  it("normalizes empty and null tags to undefined", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const withNull = createFlowRecord({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-tags",
        goal: "Null tags",
        tags: null,
      });
      expect(withNull.tags).toBeUndefined();

      const withEmpty = createFlowRecord({
        ownerKey: "agent:main:main",
        controllerId: "tests/empty-tags",
        goal: "Empty tags",
        tags: {},
      });
      expect(withEmpty.tags).toBeUndefined();
    });
  });

  // =========================================================================
  // Broad hook type listener (task:*)
  // =========================================================================

  it("broad task type listener receives all flow hook events", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const allTaskEvents: InternalHookEvent[] = [];
      registerInternalHook("task", (event) => {
        allTaskEvents.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/broad",
        goal: "Broad listener",
      });

      resumeFlow({
        flowId: created.flowId,
        expectedRevision: 0,
        status: "running",
      });

      deleteTaskFlowRecordById(created.flowId);

      await vi.waitFor(() => expect(allTaskEvents).toHaveLength(3));

      expect(allTaskEvents[0].action).toBe("flow:created");
      expect(allTaskEvents[1].action).toBe("flow:transition");
      expect(allTaskEvents[2].action).toBe("flow:deleted");
    });
  });

  // =========================================================================
  // Tag update via patch
  // =========================================================================

  it("updates tags via patch and emits no transition when status is unchanged", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const transitions: InternalHookEvent[] = [];
      registerInternalHook("task:flow:transition", (event) => {
        transitions.push(event);
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/patch-tags",
        goal: "Patch tags",
        tags: { env: "dev" },
      });

      const result = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: 0,
        patch: { tags: { env: "staging", region: "us-east" } },
      });

      expect(result.applied).toBe(true);
      if (!result.applied) {
        throw new Error("Expected update to apply");
      }
      expect(result.flow.tags).toEqual({ env: "staging", region: "us-east" });

      // No status change, so no transition hook.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transitions).toHaveLength(0);
    });
  });

  it("clears tags by patching to null", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/clear-tags",
        goal: "Clear tags",
        tags: { env: "prod" },
      });

      const result = updateFlowRecordByIdExpectedRevision({
        flowId: created.flowId,
        expectedRevision: 0,
        patch: { tags: null },
      });

      expect(result.applied).toBe(true);
      if (!result.applied) {
        throw new Error("Expected update to apply");
      }
      expect(result.flow.tags).toBeUndefined();
    });
  });

  // =========================================================================
  // Task-mirrored flow events
  // =========================================================================

  it("emits hook events for task-mirrored flow creation and sync transitions", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const allTaskEvents: InternalHookEvent[] = [];
      registerInternalHook("task", (event) => {
        allTaskEvents.push(event);
      });

      const mirroredFlow = createTaskFlowForTask({
        task: {
          ownerKey: "agent:main:main",
          taskId: "task-1",
          notifyPolicy: "done_only",
          status: "running",
          terminalOutcome: undefined,
          label: "Mirrored job",
          task: "Run mirrored job",
          createdAt: Date.now() - 1000,
          lastEventAt: Date.now(),
          endedAt: undefined,
          terminalSummary: undefined,
          progressSummary: undefined,
        },
      });

      await vi.waitFor(() => expect(allTaskEvents).toHaveLength(1));
      expect(allTaskEvents[0].action).toBe("flow:created");

      // Sync the flow with a status change via syncFlowFromTask.
      syncFlowFromTask({
        parentFlowId: mirroredFlow.flowId,
        status: "succeeded",
        terminalOutcome: "succeeded",
        notifyPolicy: "done_only",
        label: "Mirrored job",
        task: "Run mirrored job",
        lastEventAt: Date.now(),
        endedAt: Date.now(),
        taskId: "task-1",
        terminalSummary: "Done.",
        progressSummary: undefined,
      });

      await vi.waitFor(() => expect(allTaskEvents).toHaveLength(2));
      expect(allTaskEvents[1].action).toBe("flow:transition");

      const ctx = allTaskEvents[1].context as {
        flow: Record<string, unknown>;
        previousStatus: string;
      };
      expect(ctx.flow.syncMode).toBe("task_mirrored");
      expect(ctx.flow.status).toBe("succeeded");
      expect(ctx.previousStatus).toBe("running");
    });
  });

  // =========================================================================
  // Type guards
  // =========================================================================

  it("isTaskFlowCreatedEvent correctly identifies created events", () => {
    const valid = createInternalHookEvent("task", "flow:created", "agent:main:main", {
      flow: {
        flowId: "f-1",
        syncMode: "managed",
        ownerKey: "agent:main:main",
        status: "queued",
        goal: "Test",
        createdAt: Date.now(),
      },
    });
    expect(isTaskFlowCreatedEvent(valid)).toBe(true);

    const wrongAction = createInternalHookEvent("task", "flow:transition", "agent:main:main", {
      flow: { flowId: "f-1" },
    });
    expect(isTaskFlowCreatedEvent(wrongAction)).toBe(false);

    const wrongType = createInternalHookEvent("command", "flow:created", "agent:main:main", {});
    expect(isTaskFlowCreatedEvent(wrongType)).toBe(false);

    const missingFlow = createInternalHookEvent("task", "flow:created", "agent:main:main", {});
    expect(isTaskFlowCreatedEvent(missingFlow)).toBe(false);
  });

  it("isTaskFlowTransitionEvent correctly identifies transition events", () => {
    const valid = createInternalHookEvent("task", "flow:transition", "agent:main:main", {
      flow: { flowId: "f-1", status: "running" },
      previousStatus: "queued",
      durationMs: 100,
    });
    expect(isTaskFlowTransitionEvent(valid)).toBe(true);

    const missingPrev = createInternalHookEvent("task", "flow:transition", "agent:main:main", {
      flow: { flowId: "f-1" },
    });
    expect(isTaskFlowTransitionEvent(missingPrev)).toBe(false);
  });

  it("isTaskFlowDeletedEvent correctly identifies deleted events", () => {
    const valid = createInternalHookEvent("task", "flow:deleted", "agent:main:main", {
      flowId: "f-1",
      previous: { flowId: "f-1", status: "running" },
    });
    expect(isTaskFlowDeletedEvent(valid)).toBe(true);

    const missingPrevious = createInternalHookEvent("task", "flow:deleted", "agent:main:main", {
      flowId: "f-1",
    });
    expect(isTaskFlowDeletedEvent(missingPrevious)).toBe(false);

    const missingFlowId = createInternalHookEvent("task", "flow:deleted", "agent:main:main", {
      previous: { flowId: "f-1" },
    });
    expect(isTaskFlowDeletedEvent(missingFlowId)).toBe(false);
  });
});
