import { expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { CronServiceState } from "../cron/service/state.js";
import { tryFinishCronTaskRunWithoutHistory } from "../cron/service/task-runs.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  releaseAgentRunContext,
  retainQueuedAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getTaskById } from "../tasks/runtime-internal.js";
import { createSubagentTaskBackingDetail } from "../tasks/task-backing-authority.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import {
  createTaskFixture,
  finishTaskFixture,
  markTaskLostById,
  recordTaskProgressByRunId,
  reloadTaskRegistryFromStoreAsync,
} from "../tasks/task-registry.test-support.js";
import { bindTaskRunOwner } from "../tasks/task-run-owner.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";
import { runTaskHandler } from "./server-methods/tasks.test-helpers.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import {
  readTaskUpserts,
  sessionTaskDefaults,
} from "./server-runtime-subscriptions.task-ownership.test-support.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
  taskAgentOwner,
} from "./terminal/session-manager.test-helpers.js";

type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];
type Subscriptions = ReturnType<typeof startGatewayEventSubscriptions>;

export function registerTaskEventSubscriptionTests(
  start: (overrides: Partial<SubscriptionParams>) => Subscriptions,
  mockLog: SubsystemLogger,
) {
  let unsubs: Subscriptions;
  const waitForFast = (callback: () => unknown) => vi.waitFor(callback, { interval: 1 });
  it.each([
    { status: "succeeded", outcomeStatus: "ok", stopReason: "stop", ledgerStatus: "completed" },
    { status: "failed", outcomeStatus: "error", stopReason: "error", ledgerStatus: "failed" },
    { status: "cancelled", outcomeStatus: "timeout", stopReason: "rpc", ledgerStatus: "cancelled" },
    {
      status: "timed_out",
      outcomeStatus: "timeout",
      stopReason: "timeout",
      ledgerStatus: "timed_out",
    },
  ] as const)(
    "publishes settled execution without unknown before a $status task is finalized",
    async ({ status, outcomeStatus, stopReason, ledgerStatus }) => {
      const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
      const closeTaskSessions = vi.fn(() => 0);
      unsubs = start({ broadcast, terminalSessions: { closeTaskSessions } });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      const runId = `settled-task-${status}`;
      const task = createTaskFixture("cli", {
        ...sessionTaskDefaults,
        runId,
        task: "Record the finished result",
      });
      const release = bindTaskRunOwner(task, async () => ({
        ok: false,
        error: "Cancellation was not requested.",
      }));
      const lifecycle = createAgentCommandLifecycle({
        runId,
        lifecycleGeneration: getAgentRunLifecycleGeneration,
        startedAt: Date.now(),
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      try {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        broadcast.mockClear();
        const terminal = {
          metadata: {},
          outcome: buildAgentRunTerminalOutcome({ status: outcomeStatus, stopReason }),
        };
        if (status === "failed") {
          lifecycle.emitResultError({ payloads: [], meta: { durationMs: 0 } }, false, terminal);
        } else {
          lifecycle.emitEnd(terminal);
        }
        expect(getTaskById(task.taskId)?.status).toBe("running");
        expect(closeTaskSessions).not.toHaveBeenCalled();
        finishTaskFixture({ taskId: task.taskId, status, endedAt: Date.now() });
        expect(
          readTaskUpserts(broadcast).map(({ task: summary }) => ({
            status: summary.status,
            execution: summary.execution?.state,
          })),
        ).toEqual([
          { status: "running", execution: "finished" },
          { status: ledgerStatus, execution: "finished" },
        ]);
        expect(closeTaskSessions).toHaveBeenCalledExactlyOnceWith(task.taskId);
      } finally {
        release();
      }
    },
  );

  it.each(["visible", "hidden-lifecycle", "hidden-session"] as const)(
    "pushes CLI owner and capacity changes without activity for %s runs",
    async (projection) => {
      const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
      const closeTaskSessions = vi.fn(() => 0);
      unsubs = start({ broadcast, terminalSessions: { closeTaskSessions } });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      const runId = "run-cli-push";
      const sessionKey = "agent:main:dashboard:cli-push";
      const task = createTaskFixture("cli", {
        ...sessionTaskDefaults,
        childSessionKey: sessionKey,
        runId,
        task: "Show live owner changes",
      });
      const expectState = (state: string) => {
        expect(readTaskUpserts(broadcast)).toHaveLength(1);
        expect(broadcast).toHaveBeenLastCalledWith(
          "task",
          expect.objectContaining({
            action: "upserted",
            task: expect.objectContaining({ id: task.taskId, execution: { state } }),
          }),
          expect.objectContaining({ sessionKeys: [sessionTaskDefaults.requesterSessionKey] }),
        );
        broadcast.mockClear();
      };
      expectState("unknown");
      registerAgentRunContext(runId, { sessionKey, agentId: "main" });
      expect(broadcast).not.toHaveBeenCalled();
      const releaseQueuedContext = retainQueuedAgentRunContext(
        runId,
        getAgentRunLifecycleGeneration(),
      );
      expectState("running");
      releaseQueuedContext?.("abandoned");
      expectState("unknown");
      const context = {
        sessionKey,
        agentId: "main",
        projectSessionActive: projection !== "hidden-session",
        projectSessionLifecycle: projection !== "hidden-lifecycle",
      };
      if (projection === "visible") {
        registerAgentRunContext(runId, context);
      } else {
        claimAgentRunContext(runId, context, { trackOwner: true, ownsContext: true });
      }
      expectState("running");
      const releaseCapacity = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      expectState("queued");
      releaseCapacity?.();
      expectState("running");
      registerAgentRunContext(runId, context);
      expect(broadcast).not.toHaveBeenCalled();
      rotateAgentRunRegistryLifecycleGeneration();
      expectState("unknown");
      expect(closeTaskSessions).not.toHaveBeenCalled();
      await unsubs.taskUnsub();
      clearAgentRunContext(runId);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "pushes subagent capacity transitions without activity (collector=%s)",
    async (collect) => {
      const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
      const closeTaskSessions = vi.fn(() => 0);
      unsubs = start({ broadcast, terminalSessions: { closeTaskSessions } });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      const runId = "run-subagent-capacity-push";
      const sessionKey = "agent:main:subagent:capacity-push";
      subagentRuns.set(runId, {
        runId,
        childSessionKey: sessionKey,
        requesterSessionKey: sessionTaskDefaults.requesterSessionKey,
        requesterDisplayKey: "main",
        task: "Show capacity changes",
        cleanup: "keep",
        collect,
        createdAt: 1,
        generation: 1,
        execution: { status: "running", startedAt: 1 },
      });
      const claim = claimAgentRunContext(
        runId,
        { sessionKey, agentId: "main" },
        { trackOwner: true, ownsContext: true },
      );
      let releaseCapacity: (() => void) | undefined;
      try {
        const task = createTaskFixture("subagent", {
          ...sessionTaskDefaults,
          childSessionKey: sessionKey,
          runId,
          task: "Show capacity changes",
          detail: createSubagentTaskBackingDetail(1),
        });
        releaseCapacity = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
        releaseCapacity?.();
        expect(
          readTaskUpserts(broadcast).map(({ task: summary }) => ({
            id: summary.id,
            status: summary.status,
            execution: summary.execution?.state,
          })),
        ).toEqual([
          { id: task.taskId, status: "running", execution: "running" },
          { id: task.taskId, status: "running", execution: "queued" },
          { id: task.taskId, status: "running", execution: "running" },
        ]);
        for (const [event, , options] of broadcast.mock.calls) {
          if (event === "task") {
            expect(options).toEqual({
              dropIfSlow: true,
              sessionKeys: [sessionTaskDefaults.requesterSessionKey],
              agentId: "main",
            });
          }
        }
        expect(getTaskById(task.taskId)?.status).toBe("running");
        expect(closeTaskSessions).not.toHaveBeenCalled();
      } finally {
        releaseCapacity?.();
        releaseAgentRunContext(runId, claim);
        subagentRuns.delete(runId);
      }
    },
  );

  it("broadcasts bounded public task summaries with ledger statuses", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = start({ broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const completed = createTaskFixture("subagent", {
      ...sessionTaskDefaults,
      task: "Completed task",
      status: "succeeded",
      terminalSummary: "x".repeat(10_000),
    });
    const lost = createTaskFixture("cli", {
      ...sessionTaskDefaults,
      task: "Lost task",
      status: "lost",
    });

    if (!completed || !lost) {
      throw new Error("expected task records to be created");
    }
    const taskUpsertsById = new Map(readTaskUpserts(broadcast).map(({ task }) => [task.id, task]));
    expect(broadcast).toHaveBeenCalledWith(
      "task",
      expect.anything(),
      expect.objectContaining({
        dropIfSlow: true,
        sessionKeys: ["agent:main:main"],
        agentId: "main",
      }),
    );
    // Runtime registry statuses translate to the public ledger vocabulary.
    expect(taskUpsertsById.get(completed.taskId)?.status).toBe("completed");
    expect(taskUpsertsById.get(lost.taskId)?.status).toBe("failed");
    // Unbounded status text from providers/shells must be truncated on the wire.
    const wireTerminalSummary = taskUpsertsById.get(completed.taskId)?.terminalSummary;
    expect(wireTerminalSummary).toBeTruthy();
    expect(wireTerminalSummary?.length ?? 0).toBeLessThan(10_000);

    void unsubs?.taskUnsub();
    await waitForFast(() => expect(getTaskRegistryObservers()).toBeNull());
    broadcast.mockClear();
    createTaskFixture("cli", {
      ...sessionTaskDefaults,
      task: "After dispose",
      status: "queued",
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("throttles live subagent progress per task and flushes before terminal status", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = start({ broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const primary = createTaskFixture("subagent", {
      ...sessionTaskDefaults,
      childSessionKey: "agent:main:subagent:primary",
      runId: "run-throttle-primary",
      task: "Implement live progress",
      status: "running",
      detail: { notes: [["runtime-owned task detail"]] },
    });
    const secondary = createTaskFixture("subagent", {
      ...sessionTaskDefaults,
      childSessionKey: "agent:main:subagent:secondary",
      runId: "run-throttle-secondary",
      task: "Review live progress",
      status: "running",
    });
    if (!primary || !secondary) {
      throw new Error("expected task records");
    }
    broadcast.mockClear();

    for (const text of ["first", "second", "third"]) {
      emitAgentEvent({
        runId: primary.runId!,
        stream: "assistant",
        data: { text },
      });
    }
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "thinking",
      data: { text: "parallel" },
    });

    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(broadcast).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    const firstFlush = readTaskUpserts(broadcast);
    expect(firstFlush).toHaveLength(2);
    expect(firstFlush.find((event) => event.task.id === primary.taskId)?.task.lastActivity).toBe(
      "third",
    );
    expect(firstFlush.find((event) => event.task.id === secondary.taskId)?.task.lastActivity).toBe(
      "parallel",
    );

    broadcast.mockClear();
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "assistant",
      data: { text: "OpenClaw runtime context (internal): Keep internal details private." },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const sanitizedActivity = readTaskUpserts(broadcast).find(
      ({ task }) => task.id === secondary.taskId,
    );
    expect(sanitizedActivity?.task).not.toHaveProperty("lastActivity");
    expect(JSON.stringify(sanitizedActivity)).not.toContain("OpenClaw runtime context");

    broadcast.mockClear();
    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: "third" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcast).not.toHaveBeenCalled();

    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: "final activity" },
    });
    finishTaskFixture({ taskId: primary.taskId, status: "succeeded", endedAt: Date.now() });
    const terminalFlush = readTaskUpserts(broadcast).filter(
      ({ task }) => task.id === primary.taskId,
    );
    expect(terminalFlush.map((event) => event.task.status)).toEqual(["running", "completed"]);
    expect(terminalFlush[0]?.task.lastActivity).toBe("final activity");
    expect(terminalFlush[1]?.task).not.toHaveProperty("lastActivity");

    broadcast.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ["succeeded", "completed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "keeps %s publication and authoritative reads fresher than delayed final activity",
    async (status, wireStatus) => {
      const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
      unsubs = start({ broadcast });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const task = createTaskFixture("subagent", {
        ...sessionTaskDefaults,
        childSessionKey: "agent:main:subagent:delayed-final",
        runId: "run-delayed-final",
        task: "Finish after delayed activity",
        status: "running",
      });
      broadcast.mockClear();

      const endedAt = 11_000;
      vi.setSystemTime(12_000);
      emitAgentEvent({
        runId: task.runId!,
        stream: "assistant",
        data: { text: "Final activity received after the run ended" },
      });
      finishTaskFixture({ taskId: task.taskId, status, endedAt });

      const publications = readTaskUpserts(broadcast).map((event) => event.task);
      const listed = await runTaskHandler("tasks.list", {});
      const detail = await runTaskHandler("tasks.get", { taskId: task.taskId });
      expect(publications.map((snapshot) => snapshot.status)).toEqual(["running", wireStatus]);
      expect(publications[0]?.execution?.lastActivityAt).toBe(12_000);
      expect(publications[1]).not.toHaveProperty("lastActivity");
      expect(getTaskById(task.taskId)).toMatchObject({ status, endedAt, lastEventAt: endedAt });
      expect(listed.calls[0]?.[0]).toBe(true);
      expect(detail.calls[0]?.[0]).toBe(true);
      expect(listed.payload?.tasks).toEqual([
        expect.objectContaining({ id: task.taskId, status: wireStatus, updatedAt: endedAt }),
      ]);
      expect(detail.payload?.task).toMatchObject({
        id: task.taskId,
        status: wireStatus,
        updatedAt: endedAt,
      });
      expect(publications.map((snapshot) => snapshot.updatedAt)).toEqual([10_000, endedAt]);
    },
  );

  it("suppresses identical summaries and refreshes them after restore", async () => {
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = start({ broadcast });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const runId = "run-identical-task-summary";
    const task = createTaskFixture("subagent", {
      ...sessionTaskDefaults,
      childSessionKey: "agent:main:subagent:summary",
      runId,
      task: "Avoid duplicate broadcasts",
      status: "running",
      startedAt: 100,
      lastEventAt: 100,
    });
    if (!task) {
      throw new Error("expected task record");
    }
    broadcast.mockClear();

    for (let index = 0; index < 2; index += 1) {
      recordTaskProgressByRunId({
        runId,
        runtime: "subagent",
        lastEventAt: 200,
        progressSummary: "Working",
      });
    }
    const beforeRestore = readTaskUpserts(broadcast);
    expect(beforeRestore).toHaveLength(1);
    broadcast.mockClear();
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    expect(broadcast).toHaveBeenCalledWith("task", { action: "restored" }, { dropIfSlow: true });
    recordTaskProgressByRunId({
      runId,
      runtime: "subagent",
      lastEventAt: 200,
      progressSummary: "Working",
    });
    expect(readTaskUpserts(broadcast)).toEqual(beforeRestore);
    finishTaskFixture({ taskId: task.taskId, status: "succeeded", endedAt: 300 });

    const taskEvents = readTaskUpserts(broadcast);
    expect(taskEvents.map((event) => event.task.status)).toEqual(["running", "completed"]);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)(
    "closes task-run terminals exactly once for a %s transition",
    async (status) => {
      const closeTaskSessions = vi.fn(() => 1);
      unsubs = start({
        terminalSessions: { closeTaskSessions },
      });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

      const task = createTaskFixture("cron", {
        requesterSessionKey: "",
        ownerKey: "",
        scopeKind: "system",
        task: `${status} cron task`,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      if (!task) {
        throw new Error("expected task record");
      }
      const terminalize = () => {
        if (status === "lost") {
          markTaskLostById({ taskId: task.taskId, endedAt: 2_000 });
          return;
        }
        finishTaskFixture({
          taskId: task.taskId,
          status,
          endedAt: 2_000,
        });
      };

      terminalize();
      terminalize();

      expect(closeTaskSessions).toHaveBeenCalledOnce();
      expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    },
  );

  it("closes a completed cron task terminal while preserving a conversation terminal", async () => {
    const taskPty = makeFakePty();
    const persistentPty = makeFakePty();
    const ptys = [taskPty, persistentPty];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => ptys.shift() ?? makeFakePty(),
    });
    unsubs = start({
      terminalSessions: manager,
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runId = "cron:job-1:run-1";
    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskFixture("cron", {
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      runId,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    const taskOpen = await manager.open(
      baseOpenRequest({
        owner: taskAgentOwner(runSessionKey, task.taskId),
      }),
    );
    const persistentOwner = agentTerminalOwner("agent:main:main");
    const persistentOpen = await manager.open(baseOpenRequest({ owner: persistentOwner }));
    if (!taskOpen.ok || !persistentOpen.ok) {
      throw new Error("expected terminal sessions");
    }

    tryFinishCronTaskRunWithoutHistory({ deps: { log: mockLog } } as unknown as CronServiceState, {
      taskRunId: runId,
      status: "ok",
      endedAt: 2_000,
      childSessionKey: runSessionKey,
    });

    expect(taskPty.killed).toBe(true);
    expect(persistentPty.killed).toBe(false);
    expect(manager.size).toBe(1);
    expect(manager.listAgent(persistentOwner)).toHaveLength(1);
  });

  it("closes task-run terminals only after the authoritative task becomes terminal", async () => {
    const events: string[] = [];
    const closeTaskSessions = vi.fn((taskId: string) => {
      events.push(`terminal:${taskId}`);
      return 1;
    });
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>((event, payload) => {
      if (event === "task" && (payload as TaskEventPayload).action === "upserted") {
        const taskPayload = payload as Extract<TaskEventPayload, { action: "upserted" }>;
        events.push(`task:${taskPayload.task.status}`);
      }
    });
    unsubs = start({
      broadcast,
      terminalSessions: { closeTaskSessions },
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskFixture("cron", {
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    expect(closeTaskSessions).not.toHaveBeenCalled();
    expect(events).toEqual(["task:running"]);

    finishTaskFixture({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
    expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    expect(events).toEqual(["task:running", "task:completed", `terminal:${task.taskId}`]);

    // Later terminal-row updates cannot close terminals opened by a newer owner.
    finishTaskFixture({ taskId: task.taskId, status: "succeeded", endedAt: 2_001 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
  });

  it("keeps a replacement gateway's task observer when a stale unsub runs late", async () => {
    const staleBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    const staleSubs = start({
      broadcast: staleBroadcast,
    });
    await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const staleObservers = getTaskRegistryObservers();

    const replacementBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    unsubs = start({
      broadcast: replacementBroadcast,
    });
    await waitForFast(() => {
      const current = getTaskRegistryObservers();
      expect(current).not.toBeNull();
      expect(current).not.toBe(staleObservers);
    });

    // The stale dispose must not clear the replacement's observer slot.
    await staleSubs.taskUnsub();
    await staleSubs.agentUnsub();
    staleSubs.heartbeatUnsub();
    staleSubs.transcriptUnsub();
    staleSubs.lifecycleUnsub();
    expect(getTaskRegistryObservers()).not.toBeNull();

    createTaskFixture("cli", {
      ...sessionTaskDefaults,
      task: "After stale dispose",
      status: "queued",
    });
    expect(replacementBroadcast.mock.calls.some(([event]) => event === "task")).toBe(true);
    expect(staleBroadcast.mock.calls.some(([event]) => event === "task")).toBe(false);
  });
}
