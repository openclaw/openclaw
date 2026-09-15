import { expect, it, vi, type Mock } from "vitest";
import {
  claimAgentRunContext,
  claimAgentRunDelegatedAuthority,
  getAgentRunContext,
  getAgentRunContextOwnership,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  deleteTaskRecordById,
  getTaskById,
  publishTaskRecordAfterAtomicStore,
} from "../tasks/runtime-internal.js";
import { createSubagentTaskBackingDetail } from "../tasks/task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "../tasks/task-backing-authority.test-support.js";
import { finalizeTaskRunById } from "../tasks/task-executor.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { reloadTaskRegistryFromStoreAsync } from "../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryObservers,
  getTaskRegistryStore,
  type TaskRegistryObserverEvent,
} from "../tasks/task-registry.store.js";
import { createTaskFixture } from "../tasks/task-registry.test-support.js";
import { bindTaskRunOwner } from "../tasks/task-run-owner.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  baseOpenRequest,
  makeFakePty,
  taskAgentOwner,
} from "./terminal/session-manager.test-helpers.js";

type Setup = (
  broadcast: GatewayBroadcastFn,
  terminals?: Pick<TerminalSessionManager, "closeTaskSessions">,
) => { closeTaskSessions: (taskId: string) => number; taskUnsub: () => Promise<void> };

export function readTaskUpserts(broadcast: Mock<GatewayBroadcastFn>) {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    if (event !== "task") {
      return [];
    }
    const taskEvent = payload as TaskEventPayload;
    return taskEvent.action === "upserted" ? [taskEvent] : [];
  });
}

export const sessionTaskDefaults = {
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
} as const;

function createRunningTask(runId: string | null = "task-publication-run") {
  return createTaskFixture("cli", {
    ...sessionTaskDefaults,
    runId: runId ?? undefined,
    requesterSessionKey: "global",
    requesterAgentId: "main",
    task: "Task publication ownership",
    status: "running",
    lastEventAt: 1_000,
  });
}

const waitForObserver = () =>
  vi.waitFor(() => expect(getTaskRegistryObservers()).not.toBeNull(), { interval: 1 });

function onTerminalBroadcast(run: () => void) {
  return vi.fn<GatewayBroadcastFn>((name, payload) => {
    const event = payload as TaskEventPayload;
    if (name === "task" && event.action === "upserted" && event.task.status === "completed") {
      run();
    }
  });
}

export function registerTaskSubscriptionOwnershipTests(setup: Setup): void {
  it.each([
    "run",
    "requester",
    "run-owner",
    "retired",
    "metadata",
    "reload",
    "revived",
    "disposed",
    "gateway",
  ] as const)("keeps task publication current when broadcast changes %s", async (change) => {
    let replace = () => {};
    let reload: Promise<void> | undefined;
    const broadcast = onTerminalBroadcast(() => {
      const once = replace;
      replace = () => {};
      once();
    });
    const { closeTaskSessions, taskUnsub } = setup(broadcast);
    await waitForObserver();
    const task = createRunningTask();
    const cancel = async () => {
      throw new Error("unexpected cancellation");
    };
    const releaseOwner = bindTaskRunOwner(task, cancel);
    let releaseReplacement: (() => void) | undefined;
    const replacementObserver = { onEvent: vi.fn<(event: TaskRegistryObserverEvent) => void>() };
    replace = () => {
      switch (change) {
        case "run":
          updateTask(task.taskId, { runId: "replacement-run" });
          break;
        case "requester":
          updateTask(task.taskId, { requesterAgentId: "replacement" });
          break;
        case "run-owner":
          releaseReplacement = bindTaskRunOwner(getTaskById(task.taskId)!, cancel);
          break;
        case "retired":
          releaseOwner();
          break;
        case "metadata":
          updateTask(task.taskId, { terminalSummary: "More completion detail" });
          break;
        case "reload":
          reload = reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
          break;
        case "revived":
          updateTask(task.taskId, { status: "running" });
          break;
        case "disposed":
          void taskUnsub();
          break;
        case "gateway":
          configureTaskRegistryRuntime({ observers: replacementObserver });
          break;
      }
    };
    try {
      finalizeTaskRunById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
      await reload;
      if (change === "retired" || change === "metadata" || change === "reload") {
        expect(closeTaskSessions).toHaveBeenCalledExactlyOnceWith(task.taskId);
      } else {
        expect(closeTaskSessions).not.toHaveBeenCalled();
      }
      if (change === "requester") {
        expect(broadcast).toHaveBeenCalledWith(
          "task",
          expect.objectContaining({ task: expect.objectContaining({ status: "completed" }) }),
          { dropIfSlow: true, sessionKeys: ["global"], agentId: "replacement" },
        );
      }
    } finally {
      releaseOwner();
      releaseReplacement?.();
      if (getTaskRegistryObservers() === replacementObserver) {
        configureTaskRegistryRuntime({ observers: null });
      }
    }
  });

  it.each(["replaced", "retired"] as const)(
    "checks delegated execution %s during task broadcast",
    async (change) => {
      let changeExecution = () => {};
      const broadcast = onTerminalBroadcast(() => changeExecution());
      const { closeTaskSessions } = setup(broadcast);
      await waitForObserver();
      const task = createRunningTask();
      const runId = task.runId!;
      const outer = claimAgentRunContext(runId, {}, { trackOwner: true, ownsContext: true });
      if (!outer) {
        throw new Error("expected run claim");
      }
      const authority = claimAgentRunDelegatedAuthority({ runId, instanceId: "first-execution" });
      const context = getAgentRunContext(runId);
      const ownership = getAgentRunContextOwnership(runId);
      let replacement: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
      changeExecution = () => {
        if (change === "retired") {
          releaseAgentRunContext(runId, authority.claimId);
          releaseAgentRunContext(runId, outer);
        } else {
          replacement = claimAgentRunDelegatedAuthority({ runId, instanceId: "next-execution" });
        }
      };
      try {
        finalizeTaskRunById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
        if (change === "retired") {
          expect(getAgentRunContext(runId)).toBeUndefined();
          expect(closeTaskSessions).toHaveBeenCalledExactlyOnceWith(task.taskId);
        } else {
          expect(getAgentRunContext(runId)).toBe(context);
          expect(getAgentRunContextOwnership(runId)).toBe(ownership);
          expect(replacement).not.toBe(authority);
          expect(closeTaskSessions).not.toHaveBeenCalled();
        }
      } finally {
        releaseAgentRunContext(runId, authority.claimId);
        if (replacement) {
          releaseAgentRunContext(runId, replacement.claimId);
        }
        releaseAgentRunContext(runId, outer);
      }
    },
  );

  it.each([
    {
      name: "subagent generation",
      runtime: "subagent",
      first: createSubagentTaskBackingDetail(1),
      next: createSubagentTaskBackingDetail(2),
    },
    {
      name: "ACP instance",
      runtime: "acp",
      first: createAcpTaskBackingDetailForTest("first", 1),
      next: createAcpTaskBackingDetailForTest("next", 1),
    },
    {
      name: "ACP generation",
      runtime: "acp",
      first: createAcpTaskBackingDetailForTest("same", 1),
      next: createAcpTaskBackingDetailForTest("same", 2),
    },
  ] as const)(
    "keeps terminals for a newer $name during broadcast",
    async ({ runtime, first, next }) => {
      let replace = () => {};
      const broadcast = onTerminalBroadcast(() => {
        const once = replace;
        replace = () => {};
        once();
      });
      const { closeTaskSessions } = setup(broadcast);
      await waitForObserver();
      const task = createRunningTask();
      updateTask(task.taskId, { runtime, detail: first });
      replace = () => {
        updateTask(task.taskId, { detail: next });
      };
      finalizeTaskRunById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
      expect(getTaskById(task.taskId)).toMatchObject({ detail: next, status: "succeeded" });
      expect(closeTaskSessions).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "succeeded"] as const)(
    "retries a %s task summary after its broadcast fails",
    async (status) => {
      const broadcast = vi.fn<GatewayBroadcastFn>();
      setup(broadcast);
      await waitForObserver();
      const task = createRunningTask();
      broadcast.mockClear().mockImplementationOnce(() => {
        throw new Error("broadcast unavailable");
      });
      const patch = { status, progressSummary: "Ready for delivery" };
      updateTask(task.taskId, patch);
      expect(broadcast).toHaveBeenCalledOnce();
      updateTask(task.taskId, patch);
      expect(broadcast).toHaveBeenCalledTimes(2);
      updateTask(task.taskId, patch);
      expect(broadcast).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a newer identical publication when an outer broadcast rolls back", async () => {
    const broadcast = vi.fn<GatewayBroadcastFn>();
    setup(broadcast);
    await waitForObserver();
    const task = createRunningTask();
    broadcast.mockClear().mockImplementationOnce(() => {
      updateTask(task.taskId, { progressSummary: "Intermediate" });
      updateTask(task.taskId, { progressSummary: "Latest" });
      throw new Error("outer broadcast failed after reentry");
    });
    updateTask(task.taskId, { progressSummary: "Latest" });
    expect(broadcast).toHaveBeenCalledTimes(3);
    updateTask(task.taskId, { progressSummary: "Latest" });
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "preserves a terminal opened after runless task recreation during broadcast (reload: %s)",
    async (reload) => {
      const pty = makeFakePty();
      const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => pty });
      let replace = () => {};
      let restoration: Promise<void> | undefined;
      const broadcast = onTerminalBroadcast(() => {
        const once = replace;
        replace = () => {};
        once();
      });
      setup(broadcast, manager);
      await waitForObserver();
      const task = createRunningTask(null);
      expect(task.runId).toBeUndefined();
      expect(task.detail).toBeUndefined();
      let opened: ReturnType<TerminalSessionManager["open"]> | undefined;
      replace = () => {
        if (reload) {
          restoration = reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        }
        const recreated = getTaskById(task.taskId)!;
        expect(deleteTaskRecordById(task.taskId)).toBe(true);
        getTaskRegistryStore().upsertTaskWithDeliveryState({ task: recreated });
        publishTaskRecordAfterAtomicStore(recreated);
        opened = manager.open(
          baseOpenRequest({ owner: taskAgentOwner("agent:main:main", task.taskId) }),
        );
      };
      try {
        finalizeTaskRunById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
        await restoration;
        expect(opened).toBeDefined();
        await expect(opened).resolves.toMatchObject({ ok: true });
        expect(pty.killed).toBe(false);
      } finally {
        await opened;
        manager.disposeAll();
      }
    },
  );

  it("joins task observer registration when stopped immediately", async () => {
    const { taskUnsub } = setup(vi.fn<GatewayBroadcastFn>());
    await taskUnsub();
    expect(getTaskRegistryObservers()).toBeNull();
  });
}
