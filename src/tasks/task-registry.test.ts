import { afterEach, describe, expect, it, vi } from "vitest";
import { startAcpSpawnParentStreamRelay } from "../agents/acp-spawn-parent-stream.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createFlowRecord, getFlowById, resetFlowRegistryForTests } from "./flow-registry.js";
import {
  createTaskRecord,
  findLatestTaskForSessionKey,
  findTaskByRunId,
  getTaskById,
  getTaskRegistrySummary,
  listTasksForSessionKey,
  listTaskRecords,
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
  markTaskRunningByRunId,
  recordTaskProgressByRunId,
  resetTaskRegistryForTests,
  resolveTaskForLookupToken,
  setTaskProgressById,
  setTaskTimingById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  getInspectableTaskAuditSummary,
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  runTaskRegistryMaintenance,
  sweepTaskRegistry,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
  };
});

vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

async function loadFreshTaskRegistryModulesForControlTest() {
  vi.resetModules();
  vi.doMock("./task-registry-delivery-runtime.js", () => ({
    sendMessage: hoisted.sendMessageMock,
  }));
  vi.doMock("../acp/control-plane/manager.js", () => ({
    getAcpSessionManager: () => ({
      cancelSession: hoisted.cancelSessionMock,
    }),
  }));
  vi.doMock("../agents/subagent-control.js", () => ({
    killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
  }));
  return await import("./task-registry.js");
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

async function flushAsyncWork(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("task-registry", () => {
  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetTaskRegistryForTests();
    resetFlowRegistryForTests();
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("updates task status from lifecycle events", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-1",
        task: "Do the thing",
        status: "running",
        deliveryStatus: "not_applicable",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-1",
        stream: "assistant",
        data: {
          text: "working",
        },
      });
      emitAgentEvent({
        runId: "run-1",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      expect(findTaskByRunId("run-1")).toMatchObject({
        runtime: "acp",
        status: "succeeded",
        endedAt: 250,
      });
    });
  });

  it("summarizes task pressure by status and runtime", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        runId: "run-summary-acp",
        task: "Investigate issue",
        status: "queued",
        deliveryStatus: "pending",
      });
      createTaskRecord({
        runtime: "cron",
        requesterSessionKey: "",
        runId: "run-summary-cron",
        task: "Daily digest",
        status: "running",
        deliveryStatus: "not_applicable",
      });
      createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        runId: "run-summary-subagent",
        task: "Write patch",
        status: "timed_out",
        deliveryStatus: "session_queued",
      });

      expect(getTaskRegistrySummary()).toEqual({
        total: 3,
        active: 2,
        terminal: 1,
        failures: 1,
        byStatus: {
          queued: 1,
          running: 1,
          succeeded: 0,
          failed: 0,
          timed_out: 1,
          cancelled: 0,
          lost: 0,
        },
        byRuntime: {
          subagent: 1,
          acp: 1,
          cli: 0,
          cron: 1,
        },
      });
    });
  });

  it("delivers ACP completion to the requester channel when a delivery origin exists", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
          threadId: "321",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-delivery",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "delivered",
        }),
      );
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            to: "telegram:123",
            threadId: "321",
            content: expect.stringContaining("Background task done: ACP background task"),
            mirror: expect.objectContaining({
              sessionKey: "agent:main:main",
            }),
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("records delivery failure and queues a session fallback when direct delivery misses", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("telegram unavailable"));

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery-fail",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-delivery-fail",
        stream: "lifecycle",
        data: {
          phase: "error",
          endedAt: 250,
          error: "Permission denied by ACP runtime",
        },
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery-fail")).toMatchObject({
          status: "failed",
          deliveryStatus: "failed",
          error: "Permission denied by ACP runtime",
        }),
      );
      await waitForAssertion(() =>
        expect(peekSystemEvents("agent:main:main")).toEqual([
          expect.stringContaining("Background task failed: ACP background task"),
        ]),
      );
    });
  });

  it("still wakes the parent when blocked delivery misses the outward channel", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("telegram unavailable"));

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery-blocked")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "failed",
          terminalOutcome: "blocked",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("marks internal fallback delivery as session queued instead of delivered", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-session-queued",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-session-queued",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-session-queued")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        expect.stringContaining("Background task done: ACP background task"),
      ]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("wakes the parent for blocked tasks even when delivery falls back to the session", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-session-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-session-blocked")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("does not include internal progress detail in the terminal channel message", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
          threadId: "321",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-detail-leak",
        task: "Create the file and verify it",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      setTaskProgressById({
        taskId: findTaskByRunId("run-detail-leak")!.taskId,
        progressSummary:
          "I am loading the local session context and checking helper command availability before writing the file.",
      });

      emitAgentEvent({
        runId: "run-detail-leak",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Background task done: ACP background task (run run-deta).",
          }),
        ),
      );
    });
  });

  it("surfaces blocked outcomes separately from completed tasks", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-blocked-outcome",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task blocked: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Task needs follow-up: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("does not queue an unblock follow-up for ordinary completed tasks", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-succeeded-outcome",
        task: "Create the file and verify it",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalSummary: "Created /tmp/file.txt and verified contents.",
        terminalOutcome: "succeeded",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task done: ACP background task (run run-succ). Created /tmp/file.txt and verified contents.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(hasPendingHeartbeatWake()).toBe(false);
    });
  });

  it("keeps distinct task records when different producers share a runId", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:codex:acp:child",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Child ACP execution",
        status: "running",
        deliveryStatus: "not_applicable",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Spawn ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      expect(listTaskRecords().filter((task) => task.runId === "run-shared")).toHaveLength(2);
      expect(findTaskByRunId("run-shared")).toMatchObject({
        runtime: "acp",
        task: "Spawn ACP child",
      });
    });
  });

  it("suppresses duplicate ACP delivery when a preferred spawned task shares the runId", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      const directTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-shared-delivery",
        task: "Direct ACP child",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const spawnedTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-shared-delivery",
        task: "Spawn ACP child",
        preferMetadata: true,
        status: "succeeded",
        deliveryStatus: "pending",
      });

      await maybeDeliverTaskTerminalUpdate(directTask.taskId);
      await maybeDeliverTaskTerminalUpdate(spawnedTask.taskId);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(listTaskRecords().filter((task) => task.runId === "run-shared-delivery")).toHaveLength(
        1,
      );
      expect(findTaskByRunId("run-shared-delivery")).toMatchObject({
        taskId: directTask.taskId,
        task: "Spawn ACP child",
        deliveryStatus: "delivered",
      });
    });
  });

  it("adopts preferred ACP spawn metadata when collapsing onto an earlier direct record", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const directTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-preferred",
        task: "Direct ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      const spawnedTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-preferred",
        label: "Quant patch",
        task: "Implement the feature and report back",
        preferMetadata: true,
        status: "running",
        deliveryStatus: "pending",
      });

      expect(spawnedTask.taskId).toBe(directTask.taskId);
      expect(findTaskByRunId("run-collapse-preferred")).toMatchObject({
        taskId: directTask.taskId,
        label: "Quant patch",
        task: "Implement the feature and report back",
      });
    });
  });

  it("adopts parent flow linkage when collapsing onto an earlier ACP record", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const directTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-parent-flow",
        task: "Direct ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      const spawnedTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        parentFlowId: "flow-123",
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-parent-flow",
        task: "Spawn ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      expect(spawnedTask.taskId).toBe(directTask.taskId);
      expect(findTaskByRunId("run-collapse-parent-flow")).toMatchObject({
        taskId: directTask.taskId,
        parentFlowId: "flow-123",
      });
    });
  });

  it("collapses ACP run-owned task creation onto the existing spawned task", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const spawnedTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse",
        task: "Spawn ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      const directTask = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse",
        task: "Direct ACP child",
        status: "running",
      });

      expect(directTask.taskId).toBe(spawnedTask.taskId);
      expect(listTaskRecords().filter((task) => task.runId === "run-collapse")).toHaveLength(1);
      expect(findTaskByRunId("run-collapse")).toMatchObject({
        task: "Spawn ACP child",
      });
    });
  });

  it("delivers a terminal ACP update only once when multiple notifiers race", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      const task = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-racing-delivery",
        task: "Investigate issue",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      const first = maybeDeliverTaskTerminalUpdate(task.taskId);
      const second = maybeDeliverTaskTerminalUpdate(task.taskId);
      await Promise.all([first, second]);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          mirror: expect.objectContaining({
            idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          }),
        }),
      );
      expect(findTaskByRunId("run-racing-delivery")).toMatchObject({
        deliveryStatus: "delivered",
      });
    });
  });

  it("restores persisted tasks from disk on the next lookup", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        parentFlowId: "flow-restore",
        childSessionKey: "agent:main:subagent:child",
        runId: "run-restore",
        task: "Restore me",
        status: "running",
        deliveryStatus: "pending",
      });

      resetTaskRegistryForTests({
        persist: false,
      });

      expect(resolveTaskForLookupToken(task.taskId)).toMatchObject({
        taskId: task.taskId,
        parentFlowId: "flow-restore",
        runId: "run-restore",
        task: "Restore me",
      });
    });
  });

  it("indexes tasks by session key for latest and list lookups", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_700_000_000_000);

      const older = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-session-lookup-1",
        task: "Older task",
      });
      const latest = createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:child-2",
        runId: "run-session-lookup-2",
        task: "Latest task",
      });
      nowSpy.mockRestore();

      expect(findLatestTaskForSessionKey("agent:main:main")?.taskId).toBe(latest.taskId);
      expect(listTasksForSessionKey("agent:main:main").map((task) => task.taskId)).toEqual([
        latest.taskId,
        older.taskId,
      ]);
      expect(findLatestTaskForSessionKey("agent:main:subagent:child-1")?.taskId).toBe(older.taskId);
    });
  });

  it("projects inspection-time orphaned tasks as lost without mutating the registry", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost",
        task: "Missing child",
        status: "running",
        deliveryStatus: "pending",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: Date.now() - 10 * 60_000,
      });

      const tasks = reconcileInspectableTasks();
      expect(tasks[0]).toMatchObject({
        runId: "run-lost",
        status: "lost",
        error: "backing session missing",
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("marks orphaned tasks lost with cleanupAfter in a single maintenance pass", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();

      const task = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost-maintenance",
        task: "Missing child",
        status: "running",
        deliveryStatus: "pending",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: now - 10 * 60_000,
      });

      expect(runTaskRegistryMaintenance()).toEqual({
        reconciled: 1,
        cleanupStamped: 0,
        pruned: 0,
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "lost",
        error: "backing session missing",
      });
      expect(getTaskById(task.taskId)?.cleanupAfter).toBeGreaterThan(now);
    });
  });

  it("prunes old terminal tasks during maintenance sweeps", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:main",
        runId: "run-prune",
        task: "Old completed task",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        startedAt: Date.now() - 9 * 24 * 60 * 60_000,
      });
      setTaskTimingById({
        taskId: task.taskId,
        endedAt: Date.now() - 8 * 24 * 60 * 60_000,
        lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
      });

      expect(sweepTaskRegistry()).toEqual({
        reconciled: 0,
        cleanupStamped: 0,
        pruned: 1,
      });
      expect(listTaskRecords()).toEqual([]);
    });
  });

  it("previews and repairs missing cleanup timestamps during maintenance", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-missing-cleanup",
                {
                  taskId: "task-missing-cleanup",
                  runtime: "cron",
                  requesterSessionKey: "",
                  runId: "run-maintenance-cleanup",
                  task: "Finished cron",
                  status: "failed",
                  deliveryStatus: "not_applicable",
                  notifyPolicy: "silent",
                  createdAt: now - 120_000,
                  endedAt: now - 60_000,
                  lastEventAt: now - 60_000,
                },
              ],
            ]),
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(previewTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        cleanupStamped: 1,
        pruned: 0,
      });

      expect(runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        cleanupStamped: 1,
        pruned: 0,
      });
      expect(getTaskById("task-missing-cleanup")?.cleanupAfter).toBeGreaterThan(now);
    });
  });

  it("summarizes inspectable task audit findings", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-audit-summary",
                {
                  taskId: "task-audit-summary",
                  runtime: "acp",
                  requesterSessionKey: "agent:main:main",
                  runId: "run-audit-summary",
                  task: "Hung task",
                  status: "running",
                  deliveryStatus: "pending",
                  notifyPolicy: "done_only",
                  createdAt: now - 50 * 60_000,
                  startedAt: now - 40 * 60_000,
                  lastEventAt: now - 40 * 60_000,
                },
              ],
            ]),
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(getInspectableTaskAuditSummary()).toEqual({
        total: 1,
        warnings: 0,
        errors: 1,
        byCode: {
          stale_queued: 0,
          stale_running: 1,
          lost: 0,
          delivery_failed: 0,
          missing_cleanup: 0,
          inconsistent_timestamps: 0,
        },
      });
    });
  });

  it("delivers concise state-change updates only when notify policy requests them", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });

      const task = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-state-change",
        task: "Investigate issue",
        status: "queued",
        notifyPolicy: "done_only",
      });

      markTaskRunningByRunId({
        runId: "run-state-change",
        eventSummary: "Started.",
      });
      await waitForAssertion(() => expect(hoisted.sendMessageMock).not.toHaveBeenCalled());

      updateTaskNotifyPolicyById({
        taskId: task.taskId,
        notifyPolicy: "state_changes",
      });
      recordTaskProgressByRunId({
        runId: "run-state-change",
        eventSummary: "No output for 60s. It may be waiting for input.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task update: ACP background task. No output for 60s. It may be waiting for input.",
          }),
        ),
      );
      expect(findTaskByRunId("run-state-change")).toMatchObject({
        notifyPolicy: "state_changes",
      });
      await maybeDeliverTaskStateChangeUpdate(task.taskId);
      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("routes state-change updates through the parent flow owner when a task is flow-linked", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetFlowRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:flow",
        via: "direct",
      });

      const flow = createFlowRecord({
        ownerSessionKey: "agent:flow:owner",
        requesterOrigin: {
          channel: "discord",
          to: "discord:flow",
          threadId: "444",
        },
        status: "queued",
        notifyPolicy: "state_changes",
        goal: "Investigate issue",
      });

      const task = createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-state",
        task: "Investigate issue",
        status: "queued",
        notifyPolicy: "state_changes",
      });

      markTaskRunningByRunId({
        runId: "run-flow-state",
        eventSummary: "Started.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "discord",
            to: "discord:flow",
            threadId: "444",
            idempotencyKey: expect.stringContaining(`flow-event:${flow.flowId}:${task.taskId}:`),
            mirror: expect.objectContaining({
              sessionKey: "agent:flow:owner",
              idempotencyKey: expect.stringContaining(`flow-event:${flow.flowId}:${task.taskId}:`),
            }),
          }),
        ),
      );
      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "running",
      });
    });
  });

  it("keeps background ACP progress off the foreground lane and only sends a terminal notify", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-quiet-terminal",
        task: "Create the file",
        status: "running",
        deliveryStatus: "pending",
      });

      const relay = startAcpSpawnParentStreamRelay({
        runId: "run-quiet-terminal",
        parentSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        agentId: "codex",
        surfaceUpdates: false,
        streamFlushMs: 1,
        noOutputNoticeMs: 1_000,
        noOutputPollMs: 250,
      });

      relay.notifyStarted();
      emitAgentEvent({
        runId: "run-quiet-terminal",
        stream: "assistant",
        data: {
          delta: "working on it",
        },
      });
      vi.advanceTimersByTime(10);

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();

      emitAgentEvent({
        runId: "run-quiet-terminal",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });
      await flushAsyncWork();

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          to: "discord:123",
          content: "Background task done: ACP background task (run run-quie).",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("delivers a concise terminal failure message without internal ACP chatter", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-failure-terminal",
        task: "Write the file",
        status: "running",
        deliveryStatus: "pending",
        progressSummary:
          "I am loading session context and checking helper availability before writing the file.",
      });

      emitAgentEvent({
        runId: "run-failure-terminal",
        stream: "lifecycle",
        data: {
          phase: "error",
          endedAt: 250,
          error: "Permission denied by ACP runtime",
        },
      });
      await flushAsyncWork();

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          to: "discord:123",
          content:
            "Background task failed: ACP background task (run run-fail). Permission denied by ACP runtime",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("routes terminal delivery through the parent flow owner when a task is flow-linked", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetFlowRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:flow",
        via: "direct",
      });

      const flow = createFlowRecord({
        ownerSessionKey: "agent:flow:owner",
        requesterOrigin: {
          channel: "discord",
          to: "discord:flow",
          threadId: "444",
        },
        status: "running",
        goal: "Investigate issue",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-terminal",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      emitAgentEvent({
        runId: "run-flow-terminal",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });
      await flushAsyncWork();

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "discord",
            to: "discord:flow",
            threadId: "444",
            idempotencyKey: expect.stringContaining(`flow-terminal:${flow.flowId}:`),
            mirror: expect.objectContaining({
              sessionKey: "agent:flow:owner",
            }),
          }),
        ),
      );
      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "succeeded",
        endedAt: 250,
      });
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("queues fallback terminal delivery on the parent flow owner session when a task is flow-linked", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetFlowRegistryForTests();
      resetSystemEventsForTest();

      const flow = createFlowRecord({
        ownerSessionKey: "agent:flow:owner",
        status: "running",
        goal: "Investigate issue",
      });

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-fallback",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      emitAgentEvent({
        runId: "run-flow-fallback",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });
      await flushAsyncWork();

      await waitForAssertion(() =>
        expect(peekSystemEvents("agent:flow:owner")).toEqual([
          "Background task done: ACP background task (run run-flow).",
        ]),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(findTaskByRunId("run-flow-fallback")).toMatchObject({
        deliveryStatus: "session_queued",
      });
    });
  });

  it("emits concise state-change updates without surfacing raw ACP chatter", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-state-stream",
        task: "Create the file",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
      });

      const relay = startAcpSpawnParentStreamRelay({
        runId: "run-state-stream",
        parentSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        agentId: "codex",
        surfaceUpdates: false,
        streamFlushMs: 1,
        noOutputNoticeMs: 1_000,
        noOutputPollMs: 250,
      });

      relay.notifyStarted();
      await flushAsyncWork();
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Background task update: ACP background task. Started.",
        }),
      );

      hoisted.sendMessageMock.mockClear();
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "Background task update: ACP background task. No output for 1s. It may be waiting for input.",
        }),
      );

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("cancels ACP-backed tasks through the ACP session manager", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      const registry = await loadFreshTaskRegistryModulesForControlTest();
      process.env.OPENCLAW_STATE_DIR = root;
      registry.resetTaskRegistryForTests();
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const task = registry.createTaskRecord({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-cancel-acp",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await registry.cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          sessionKey: "agent:codex:acp:child",
          reason: "task-cancel",
        }),
      );
      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
          error: "Cancelled by operator.",
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            to: "telegram:123",
            content: "Background task cancelled: ACP background task (run run-canc).",
          }),
        ),
      );
    });
  });

  it("cancels subagent-backed tasks through subagent control", async () => {
    await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
      const registry = await loadFreshTaskRegistryModulesForControlTest();
      process.env.OPENCLAW_STATE_DIR = root;
      registry.resetTaskRegistryForTests();
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const task = registry.createTaskRecord({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-cancel-subagent",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await registry.cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          sessionKey: "agent:worker:subagent:child",
        }),
      );
      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
          error: "Cancelled by operator.",
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            to: "telegram:123",
            content: "Background task cancelled: Subagent task (run run-canc).",
          }),
        ),
      );
    });
  });
});
