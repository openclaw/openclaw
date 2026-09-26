import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "../agents/subagents/registry/subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type {
  ProgressContinuationReceipt,
  ProgressContinuationState,
} from "../channels/progress-continuation.js";
import { projectAgentToolActivity } from "../infra/agent-activity-events.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import {
  createTaskProgressContinuation,
  withTaskProgressRequesterContinuation,
} from "./task-progress-requester.js";
import type { sendMessage as SendMessage } from "./task-registry-delivery-runtime.js";
import { resetTaskRegistryListenerState } from "./task-registry-listener-state.js";
import {
  registerTaskProgressAuthorityTests,
  type TaskProgressTestChild as Child,
} from "./task-registry-progress-authority.test-utils.js";
import type * as ProgressRuntime from "./task-registry-progress-runtime.js";
import type { TaskProgressPublication } from "./task-registry-progress-runtime.js";
import { updateTaskStateByRunId } from "./task-registry-record-api.js";
import { runTaskRegistryWorkerMutation, tasks } from "./task-registry-state.js";
import {
  createTaskRecord,
  getTaskById,
  markTaskTerminalById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
}));

// SQLite receipts and transport edits are exercised by task-registry-progress-runtime.test.ts.
const runtime = vi.hoisted(() => ({
  adoptTaskProgressMessage: vi.fn<typeof ProgressRuntime.adoptTaskProgressMessage>(),
  readTaskProgressSnapshot: vi.fn<typeof ProgressRuntime.readTaskProgressSnapshot>(),
  publishTaskProgressMessage: vi.fn<typeof ProgressRuntime.publishTaskProgressMessage>(),
  deleteTaskProgressMessage: vi.fn<typeof ProgressRuntime.deleteTaskProgressMessage>(),
  startTaskProgressTyping: vi.fn(() => false),
}));
vi.mock("./task-registry-progress-runtime.js", () => runtime);

const PARENT = "agent:main:parent";
const TURN = "parent-turn";
const origin = {
  channel: "notifychat",
  to: "synthetic-recipient",
  accountId: "test",
  threadId: "test-thread",
};
const receipts = new Map<string, ProgressContinuationReceipt>();
const publications: Array<TaskProgressPublication & { messageId: string }> = [];
const sendMessage = vi.hoisted(() => vi.fn<typeof SendMessage>());
vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage,
  prepareTaskControlUiSessionUrl: async () => () => undefined,
}));
const notifications: Array<Parameters<typeof SendMessage>[0]> = [];
const runContextClaims: Array<{ runId: string; claim: string }> = [];

function receipt(messageId = "existing-parent-card"): ProgressContinuationReceipt {
  return {
    ...origin,
    messageId,
    text: "Release review\nCheck release gates\nPublish the release\nParent checking the release plan",
    snapshot: {
      label: "Release review",
      plan: [
        { step: "Check release gates", status: "in_progress" },
        { step: "Publish the release", status: "pending" },
      ],
      statusHeadline: "Parent checking the release plan",
      statusHeadlineFormat: "plain",
      lines: [],
    },
  };
}

function child(
  name: string,
  options: { notifyPolicy?: TaskNotifyPolicy; generation?: number; turn?: string } = {},
) {
  const generation = options.generation ?? 1;
  const entry: SubagentRunRecord = {
    runId: `run-${name}`,
    childSessionKey: `agent:main:subagent:${name}`,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    requesterDisplayKey: PARENT,
    requesterTurnRunId: options.turn ?? TURN,
    requesterTurnYielded: true,
    completionRequesterSessionId: "requester-window",
    requesterOrigin: { ...origin },
    task: "Private child assignment",
    label: name,
    cleanup: "keep",
    createdAt: Date.now(),
    generation,
    execution: { status: "running", startedAt: Date.now() },
    expectsCompletionMessage: true,
  };
  subagentRuns.set(entry.runId, entry);
  const claim = claimAgentRunContext(
    entry.runId,
    { sessionKey: entry.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  if (!claim) {
    throw new Error("Expected child execution ownership");
  }
  runContextClaims.push({ runId: entry.runId, claim });
  const task = createTaskRecord({
    runtime: "subagent",
    ownerKey: PARENT,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    scopeKind: "session",
    childSessionKey: entry.childSessionKey,
    runId: entry.runId,
    label: name,
    task: entry.task,
    status: "running",
    notifyPolicy: options.notifyPolicy ?? "state_changes",
    deliveryStatus: "pending",
    requesterOrigin: { ...origin },
    detail: createSubagentTaskBackingDetail(generation),
  });
  if (!task) {
    throw new Error("Expected accepted task");
  }
  return { entry, task, claim };
}

function accepted(items: readonly Child[]) {
  return items.map(({ entry }) => ({
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    expectsCompletionMessage: true,
  }));
}

function settle(items: readonly Child[], progressPresentation?: ProgressContinuationState) {
  return settleRequesterTurnAfterSessionSpawns({
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    requesterTurnRunId: items[0]?.entry.requesterTurnRunId ?? TURN,
    requesterYielded: true,
    acceptedSessionSpawns: accepted(items),
    progressPresentation,
    runs: subagentRuns,
    persistOrThrow: () => {},
    schedule: () => {},
  });
}

function continuation(items: readonly Child[]) {
  return createTaskProgressContinuation({
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    requesterTurnRunId: items[0]?.entry.requesterTurnRunId ?? TURN,
    acceptedSessionSpawns: accepted(items),
    onAdopted: (state) => {
      if (!settle(items, state)) {
        throw new Error("Requester settlement did not accept the adopted card");
      }
    },
  });
}

async function adopt(items: readonly Child[], card = receipt()) {
  const capability = await continuation(items);
  if (!capability) {
    throw new Error("Expected current requester handoff capability");
  }
  expect(await capability.adopt(card)).toBe(true);
  capability.close();
  return capability;
}

function tool(entry: SubagentRunRecord, index = 1) {
  emitAgentEvent({
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    stream: "item",
    data: projectAgentToolActivity({
      toolCallId: `call-${index}`,
      name: "read",
      phase: "start",
      args: { path: `public-notes-${index}.txt`, secret: "private-tool-arguments" },
    }),
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  subagentRuns.clear();
  receipts.clear();
  publications.length = 0;
  notifications.length = 0;
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  sendMessage.mockReset().mockImplementation(async (params) => {
    await params.onPlatformSendDispatch?.();
    params.assertDirectAdapterHandoff?.();
    notifications.push(params);
    return {
      channel: origin.channel,
      to: params.to,
      via: "direct",
      mediaUrl: null,
      deliveryStatus: "sent",
    };
  });
  runtime.adoptTaskProgressMessage.mockReset().mockImplementation(async (params) => {
    params.assertCurrent();
    receipts.set(params.operationId, structuredClone(params.receipt));
    return true;
  });
  runtime.readTaskProgressSnapshot.mockReset().mockImplementation(({ operationId }) => {
    const snapshot = receipts.get(operationId)?.snapshot;
    return snapshot ? structuredClone(snapshot) : undefined;
  });
  runtime.publishTaskProgressMessage.mockReset().mockImplementation(async (params) => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    const card = receipts.get(params.operationId);
    if (!card) {
      return "suppressed";
    }
    if (params.previousContent === params.content) {
      card.snapshot = structuredClone(params.snapshot);
      return "unchanged";
    }
    publications.push({ ...params, origin: { ...params.origin }, messageId: card.messageId });
    card.snapshot = structuredClone(params.snapshot);
    card.text = params.content;
    return "sent";
  });
  runtime.deleteTaskProgressMessage.mockReset().mockImplementation(async (params) => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    return receipts.delete(params.operationId) ? "sent" : "unknown";
  });
  // Await real module readiness, not timer ticks, before exercising the lazy coordinator.
  await Promise.all([
    import("./task-progress-presentation.js"),
    import("./task-registry-progress-runtime.js"),
  ]);
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  for (const { runId, claim } of runContextClaims) {
    releaseAgentRunContext(runId, claim);
  }
  runContextClaims.length = 0;
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  subagentRuns.clear();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("adopted requester progress", () => {
  it("updates the existing checklist with public child progress after the requester scope closes", async () => {
    const first = child("First");
    const second = child("Second");
    tool(first.entry);
    const requester = new AsyncWorkScope();
    const root = tryBeginGatewayRootWorkAdmission("test:yielded-requester");
    if (!root) {
      throw new Error("Expected admitted requester");
    }
    let requesterContext: <T>(run: () => T) => T;
    try {
      requesterContext = await root.run(() =>
        requester.run(async () => {
          const context = AsyncLocalStorage.snapshot();
          await adopt([first, second]);
          return context;
        }),
      );
    } finally {
      root.release();
      await requester.drain();
    }
    expect(requester.signal.aborted).toBe(true);
    first.entry.requesterOrigin = { ...origin, to: "later-requester-route" };
    tool(second.entry, 2);
    emitAgentEvent({
      runId: first.entry.runId,
      sessionKey: first.entry.childSessionKey,
      stream: "item",
      data: {
        itemId: "commentary",
        kind: "preamble",
        phase: "end",
        title: "Commentary",
        status: "completed",
        progressText: "Checking release gates.",
      },
    });
    emitAgentEvent({
      runId: first.entry.runId,
      stream: "assistant",
      data: { text: "private-child-text" },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(publications).toEqual([]);
    // Vitest timers need the original ALS context restored to exercise detached admission.
    await requesterContext(() => {
      expect(getAsyncWorkSignal()).toBe(requester.signal);
      return vi.advanceTimersByTimeAsync(1);
    });
    expect(publications).toHaveLength(1);
    const display = publications[0]!;
    expect(display.messageId).toBe("existing-parent-card");
    expect(display.origin).toEqual(origin);
    expect(display.content).toContain("Check release gates");
    expect(display.content).toContain("Publish the release");
    expect(display.content).toContain("Parent checking the release plan");
    expect(display.content).toContain("First");
    expect(display.content).toContain("Second");
    expect(display.content).toContain("public-notes-1.txt");
    expect(display.content).toContain("public-notes-2.txt");
    expect(display.content).toContain("Checking release gates.");
    expect(display.content).not.toMatch(/private-|Private child assignment/);
    expect(getTaskById(first.task.taskId)).toMatchObject({
      status: "running",
      deliveryStatus: "pending",
    });
    expect(peekSystemEvents(PARENT)).toEqual([]);

    emitAgentEvent({
      runId: second.entry.runId,
      sessionKey: second.entry.childSessionKey,
      stream: "item",
      data: {
        ...projectAgentToolActivity({
          toolCallId: "call-2",
          name: "read",
          phase: "result",
          args: { path: "public-notes-2.txt" },
          isError: false,
        }),
        hideFromChannelProgress: true,
      },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(2);
    expect(publications[1]?.messageId).toBe("existing-parent-card");
    expect(publications[1]?.content).not.toContain("public-notes-2.txt");
    expect(publications[1]?.content).toContain("public-notes-1.txt");
    expect(publications[1]?.content).toContain("Publish the release");
  });

  it.each(["generation", "run binding"] as const)(
    "excludes activity captured after a committed %s replacement awaiting publication",
    async (replacement) => {
      const first = child("Replaced");
      const second = child("Current");
      await adopt([first, second]);
      const store = getTaskRegistryStore();
      const context = captureOpenClawStateWorkerContext();
      const replaced = {
        ...first.task,
        ...(replacement === "generation"
          ? { detail: createSubagentTaskBackingDetail(2) }
          : { runId: "replacement-run" }),
      };
      const release = createDeferred();
      const pending = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope: { taskId: first.task.taskId, runId: replaced.runId! },
          publicationRecords: () => new Map([[first.task.taskId, replaced]]),
        },
        async () => {
          store.upsertTaskWithDeliveryState({
            task: replaced,
            deliveryState: store.loadSnapshot().deliveryStates.get(first.task.taskId),
          });
          await release.promise;
        },
        async () => store.loadSnapshot(),
      );
      try {
        expect(tasks.get(first.task.taskId)?.runId).toBe(first.entry.runId);
        emitAgentEvent({
          runId: first.entry.runId,
          sessionKey: first.entry.childSessionKey,
          stream: "tool",
          data: { phase: "start", name: "read" },
        });
        tool(first.entry, 99);
        tool(second.entry, 2);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(publications).toHaveLength(1);
        expect(publications[0]?.content).toContain("Current");
        expect(publications[0]?.content).toContain("public-notes-2.txt");
        expect(publications[0]?.content).not.toContain("public-notes-99.txt");
        expect(store.loadSnapshot().tasks.get(first.task.taskId)).toMatchObject(replaced);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("resumes the existing card when tasks restore before listeners attach", async () => {
    const item = child("Worker");
    await adopt([item]);
    const stored = getTaskRegistryStore().loadSnapshot();
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore(stored),
    });

    expect(getTaskById(item.task.taskId)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications.map((entry) => entry.messageId)).toEqual(["existing-parent-card"]);
    expect(publications[0]?.content).toContain("Worker");
    expect(publications[0]?.content).toContain("Publish the release");
  });

  it("shows a recovered generation's failure without waiting for public activity", async () => {
    const item = child("Worker");
    await adopt([item]);
    await vi.advanceTimersByTimeAsync(15_000);
    const recoveredRunId = "recovered-worker";
    subagentRuns.delete(item.entry.runId);
    subagentRuns.set(recoveredRunId, {
      ...item.entry,
      runId: recoveredRunId,
      taskRunId: item.entry.runId,
      generation: 2,
      requesterSettleWake: {
        ...item.entry.requesterSettleWake!,
        batchRunIds: [recoveredRunId],
      },
      execution: { status: "terminal", endedAt: Date.now() },
    });
    updateTaskStateByRunId({
      taskId: item.task.taskId,
      runId: item.entry.runId,
      runtime: "subagent",
      detail: createSubagentTaskBackingDetail(2),
      status: "failed",
      endedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications.map((entry) => entry.messageId)).toEqual([
      "existing-parent-card",
      "existing-parent-card",
    ]);
    expect(publications.at(-1)?.content).toContain("Worker (failed)");
  });

  it.each(["no card", "adoption refused"] as const)(
    "coalesces state-only notifications without creating a retained receipt after %s",
    async (state) => {
      const first = child("First");
      const second = child("Second");
      if (state === "adoption refused") {
        runtime.adoptTaskProgressMessage.mockResolvedValueOnce(false);
        const capability = (await continuation([first, second]))!;
        expect(await capability.adopt(receipt())).toBe(false);
        expect(await capability.adopt(receipt("retry-card"))).toBe(false);
        capability.close();
      } else {
        first.entry.completionRequesterSessionId = undefined;
        second.entry.completionRequesterSessionId = undefined;
      }
      tool(first.entry);
      expect(settle([first, second])).toBe(true);
      for (let index = 0; index < 3; index++) {
        tool(second.entry, index);
      }
      await vi.advanceTimersByTimeAsync(14_999);
      expect(notifications).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        ...origin,
        mirror: { sessionKey: PARENT, agentId: "main" },
      });
      expect(notifications[0]!.content).toContain("First");
      expect(notifications[0]!.content).toContain("Second");
      expect(notifications[0]!.content).toContain("running");
      expect(notifications[0]!.content).not.toContain("public-notes");
      expect(notifications[0]!.content).not.toContain("private-");
      expect(getTaskById(first.task.taskId)).toMatchObject({
        status: "running",
        deliveryStatus: "pending",
      });
      expect(first.entry.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(peekSystemEvents(PARENT)).toEqual([]);
      expect(runtime.publishTaskProgressMessage).not.toHaveBeenCalled();
      expect(receipts.size).toBe(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notifications).toHaveLength(1);
    },
  );

  it("does not replace an identified retained card whose snapshot is missing", async () => {
    const item = child("Worker");
    await adopt([item]);
    receipts.clear();
    tool(item.entry);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.publishTaskProgressMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("excludes completed children and their pending activity from generic notifications", async () => {
    const first = child("Finished");
    const second = child("Active");
    expect(settle([first, second])).toBe(true);
    tool(first.entry, 1);
    tool(second.entry, 2);
    markTaskTerminalById({ taskId: first.task.taskId, status: "succeeded", endedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.content).toContain("Active");
    expect(notifications[0]!.content).toContain("running");
    expect(notifications[0]!.content).not.toMatch(/Finished|public-notes|succeeded/);
    expect(getTaskById(second.task.taskId)).toMatchObject({
      status: "running",
      deliveryStatus: "pending",
    });
  });

  it.each(["rearm", "membership", "finish", "resume", "dispatch"] as const)(
    "drops generic progress after its yielded authority changes: %s",
    async (change) => {
      const item = child("Worker");
      expect(settle([item])).toBe(true);
      tool(item.entry);
      switch (change) {
        case "rearm":
          item.entry.requesterSettleWake!.rearmGeneration = 2;
          break;
        case "membership":
          item.entry.requesterSettleWake!.batchRunIds!.push("different-wave");
          break;
        case "finish":
          markTaskTerminalById({
            taskId: item.task.taskId,
            status: "succeeded",
            endedAt: Date.now(),
          });
          break;
        case "resume": {
          const runId = "resumed-requester";
          const claim = claimAgentRunContext(
            runId,
            { sessionKey: PARENT, agentId: "main", projectSessionActive: true },
            { trackOwner: true, ownsContext: true },
          );
          if (!claim) {
            throw new Error("Expected requester execution ownership");
          }
          runContextClaims.push({ runId, claim });
          break;
        }
        case "dispatch":
          item.entry.requesterSettleWake!.status = "dispatching";
          break;
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(publications).toEqual([]);
    },
  );

  it("rechecks generic authority at transport and carries newer activity to the next notification", async () => {
    const first = child("First");
    expect(settle([first])).toBe(true);
    const send = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementationOnce(async (params) => {
      first.entry.requesterSettleWake!.rearmGeneration = 2;
      return send(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notifications).toEqual([]);
    const second = child("Second", { turn: "second-turn" });
    expect(settle([second])).toBe(true);
    sendMessage.mockImplementationOnce(async (params) => {
      tool(second.entry, 2);
      return send(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notifications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.content).toContain("Second");
    expect(notifications[1]!.content).not.toContain("public-notes");
    expect(receipts.size).toBe(0);
  });

  it("keeps silent children silent and allows done-only children to continue an adopted card", async () => {
    const quiet = child("Quiet", { notifyPolicy: "silent" });
    expect(await continuation([quiet])).toBeUndefined();
    expect(settle([quiet])).toBe(true);
    tool(quiet.entry);
    const doneOnly = child("Done only", { notifyPolicy: "done_only", turn: "quiet-turn" });
    expect(settle([doneOnly])).toBe(true);
    tool(doneOnly.entry);
    const visible = child("Visible", { notifyPolicy: "done_only", turn: "next-turn" });
    await adopt([visible]);
    tool(visible.entry);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.content).toContain("Visible");
    expect(publications[0]!.content).toContain("public-notes-1.txt");
    expect(publications[0]!.content).not.toContain("Quiet");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a retained capability after close and a second adoption after use", async () => {
    const item = child("Worker");
    const closed = (await continuation([item]))!;
    closed.close();
    expect(await closed.adopt(receipt("closed-card"))).toBe(false);
    const used = (await continuation([item]))!;
    expect(await used.adopt(receipt())).toBe(true);
    expect(await used.adopt(receipt("replacement-card"))).toBe(false);
    used.close();
    tool(item.entry);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications.map((display) => display.messageId)).toEqual(["existing-parent-card"]);
  });

  it.each(["replace", "cancel", "close", "restart"] as const)(
    "rejects adoption when the owner changes during its await: %s",
    async (change) => {
      const item = child("Worker");
      const entered = createDeferred();
      const finished = createDeferred<boolean>();
      runtime.adoptTaskProgressMessage.mockImplementationOnce(async () => {
        entered.resolve();
        return finished.promise;
      });
      const capability = (await continuation([item]))!;
      const pending = capability.adopt(receipt());
      await entered.promise;
      expect(await capability.adopt(receipt("concurrent-replacement"))).toBe(false);
      if (change === "replace") {
        subagentRuns.set(item.entry.runId, { ...item.entry, generation: 2 });
      } else if (change === "cancel") {
        item.entry.killIntent = { requestedAt: Date.now(), reason: "operator cancelled" };
      } else if (change === "close") {
        capability.close();
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      finished.resolve(true);
      expect(await pending).toBe(false);
      capability.close();
      tool(item.entry);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(publications).toEqual([]);
    },
  );

  it.each([
    "cancel",
    "replace",
    "audience",
    "unlisted",
    "settled",
    "presentation",
    "mute",
    "drain",
    "restart",
    "reset",
  ] as const)("does not publish queued work after %s", async (change) => {
    const item = child("Worker");
    await adopt([item]);
    tool(item.entry);
    switch (change) {
      case "cancel":
        item.entry.killIntent = { requestedAt: Date.now(), reason: "operator cancelled" };
        break;
      case "replace":
        subagentRuns.set(item.entry.runId, { ...item.entry, generation: 2 });
        break;
      case "presentation":
        item.entry.requesterSettleWake!.progressOperationId = "another-card";
        break;
      case "audience":
        item.entry.requesterSessionKey = "agent:main:other-requester";
        break;
      case "unlisted":
        item.entry.requesterSettleWake!.batchRunIds = ["another-batch-member"];
        break;
      case "settled":
        item.entry.requesterSettleWake = undefined;
        break;
      case "mute":
        updateTaskNotifyPolicyById({ taskId: item.task.taskId, notifyPolicy: "silent" });
        break;
      case "drain":
        markGatewayRestartDraining();
        break;
      case "restart":
        rotateAgentEventLifecycleGeneration();
        break;
      case "reset":
        resetTaskRegistryListenerState();
        break;
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toEqual([]);
    if (change === "cancel") {
      item.entry.execution = { status: "terminal", endedAt: Date.now() };
      item.entry.requesterSettleWake = undefined;
      item.entry.suppressAnnounceReason = "killed";
      markTaskTerminalById({ taskId: item.task.taskId, status: "cancelled", endedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(publications).toHaveLength(1);
      expect(publications[0]?.content).toContain("Worker (cancelled)");
      const cancelledLine = publications[0]?.content
        .split("\n")
        .find((line) => line.includes("Worker (cancelled)"));
      expect(cancelledLine).not.toContain("failed");
      tool(item.entry, 99);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(publications).toHaveLength(1);
    }
  });

  it("finishes the retained plan from only its admitted requester turn", async () => {
    const item = child("Worker");
    await adopt([item]);
    item.entry.execution = { status: "terminal", endedAt: Date.now() };
    markTaskTerminalById({ taskId: item.task.taskId, status: "succeeded", endedAt: Date.now() });
    const steps = receipt().snapshot.plan!;
    for (const step of steps) {
      step.status = "completed";
    }
    await withTaskProgressRequesterContinuation(
      {
        entries: [item.entry],
        runId: "resumed-requester",
        requesterSessionId: "requester-window",
        isCurrent: () => true,
      },
      async () => {
        emitAgentEvent({
          runId: "unrelated-requester",
          stream: "plan",
          data: { phase: "update", steps: [{ step: "Unrelated private plan", status: "pending" }] },
        });
        emitAgentEvent({
          runId: "resumed-requester",
          stream: "plan",
          data: { phase: "update", steps },
        });
        emitAgentEvent({
          runId: "resumed-requester",
          stream: "item",
          data: {
            itemId: "parent-finish",
            kind: "preamble",
            phase: "end",
            title: "Commentary",
            progressText: "The verified results are ready.",
          },
        });
        return { delivered: true, path: "direct" };
      },
    );
    const final = publications.at(-1)!;
    expect(final.messageId).toBe("existing-parent-card");
    expect(final.snapshot.plan).toEqual(steps);
    expect(final.content).toContain("The verified results are ready.");
    expect(final.content).not.toContain("Unrelated private plan");
  });

  it("keeps the same card when the resumed requester delegates another wave", async () => {
    const first = child("First");
    await adopt([first]);
    first.entry.execution = { status: "terminal", endedAt: Date.now() };
    markTaskTerminalById({ taskId: first.task.taskId, status: "succeeded", endedAt: Date.now() });
    await withTaskProgressRequesterContinuation(
      {
        entries: [first.entry],
        runId: "resumed-requester",
        requesterSessionId: "requester-window",
        isCurrent: () => true,
      },
      async () => {
        const next = child("Next", { turn: "resumed-requester" });
        expect(settle([next])).toBe(true);
        tool(next.entry, 2);
        return { delivered: true, path: "direct", requesterVisibleFinalDelivered: true };
      },
    );
    first.entry.requesterSettleWake = undefined;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications.map((entry) => entry.messageId)).toEqual(["existing-parent-card"]);
    expect(publications[0]?.content).toContain("Next");
    expect(publications[0]?.content).toContain("public-notes-2.txt");
  });

  it.each(["pending", "dispatching"] as const)(
    "keeps terminal child status on the adopted card while the requester wake is %s",
    async (status) => {
      const item = child("Worker");
      tool(item.entry);
      await adopt([item]);
      await vi.advanceTimersByTimeAsync(15_000);
      for (let index = 2; index <= 24; index += 1) {
        tool(item.entry, index);
      }
      emitAgentEvent({
        runId: item.entry.runId,
        sessionKey: item.entry.childSessionKey,
        stream: "item",
        data: projectAgentToolActivity({
          toolCallId: "call-1",
          name: "read",
          phase: "result",
          args: { path: "public-notes-1.txt" },
          isError: false,
        }),
      });
      item.entry.execution = { status: "terminal", endedAt: Date.now() };
      item.entry.requesterSettleWake!.status = status;
      releaseAgentRunContext(item.entry.runId, item.claim);
      markTaskTerminalById({ taskId: item.task.taskId, status: "succeeded", endedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(publications).toHaveLength(2);
      const final = publications.at(-1)!;
      expect(final.content).toContain("Worker (succeeded)");
      expect(final.content).toContain("Publish the release");
      expect(final.content).not.toContain("running");
      expect(final.snapshot.lines).toContainEqual(
        expect.objectContaining({ toolName: "read", status: "completed" }),
      );
      expect(peekSystemEvents(PARENT)).toEqual([]);
    },
  );

  it("does not report a retained tool as running after its execution claim releases", async () => {
    const item = child("Worker");
    tool(item.entry);
    await adopt([item]);
    releaseAgentRunContext(item.entry.runId, item.claim);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.content).toContain("Current activity unavailable");
    expect(publications[0]!.content).not.toMatch(/running|private-/);
  });

  it("requires fresh adoption for a new generation reusing the same run id", async () => {
    const first = child("Worker");
    tool(first.entry, 1);
    await adopt([first]);
    releaseAgentRunContext(first.entry.runId, first.claim);
    const replacement = child("Worker", { generation: 2, turn: "replacement-turn" });
    tool(replacement.entry, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toEqual([]);
    await adopt([replacement], receipt("replacement-generation-card"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.messageId).toBe("replacement-generation-card");
    expect(publications[0]!.content).toContain("public-notes-2.txt");
    expect(publications[0]!.content).not.toContain("public-notes-1.txt");
    expect(publications[0]!.origin).toEqual(origin);
  });

  it("adopts the current execution using the original accepted task receipt", async () => {
    const item = child("Worker", { generation: 2 });
    const spawns = accepted([item]);
    const taskRunId = item.entry.runId;
    releaseAgentRunContext(taskRunId, item.claim);
    subagentRuns.delete(taskRunId);
    item.entry.taskRunId = taskRunId;
    item.entry.runId = "replacement-execution";
    subagentRuns.set(item.entry.runId, item.entry);
    const claim = claimAgentRunContext(
      item.entry.runId,
      { sessionKey: item.entry.childSessionKey },
      { trackOwner: true, ownsContext: true },
    );
    if (!claim) {
      throw new Error("Replacement execution did not acquire its own claim");
    }
    runContextClaims.push({ runId: item.entry.runId, claim });
    const capability = await createTaskProgressContinuation({
      requesterSessionKey: PARENT,
      requesterAgentId: "main",
      requesterTurnRunId: TURN,
      acceptedSessionSpawns: spawns,
      onAdopted: (progressPresentation) => {
        expect(
          settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: PARENT,
            requesterAgentId: "main",
            requesterTurnRunId: TURN,
            requesterYielded: true,
            acceptedSessionSpawns: spawns,
            progressPresentation,
            runs: subagentRuns,
            persistOrThrow: () => {},
            schedule: () => {},
          }),
        ).toBe(true);
      },
    });
    expect(capability).toBeDefined();
    await expect(capability?.adopt(receipt())).resolves.toBe(true);
    capability?.close();
    tool(item.entry, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.messageId).toBe("existing-parent-card");
    expect(publications[0]?.content).toContain("public-notes-2.txt");
  });

  it("excludes unaccepted children and rejects an oversized adoption instead of transferring a subset", async () => {
    const selected = child("Selected");
    const outsider = child("Outsider", { turn: "other-turn" });
    await adopt([selected]);
    tool(selected.entry);
    tool(outsider.entry, 99);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.content).toContain("Selected");
    expect(publications[0]!.content).not.toMatch(/Outsider|public-notes-99/);
    const large = Array.from({ length: 33 }, (_, index) =>
      child(`Batch ${index}`, { turn: "large-turn" }),
    );
    expect(await continuation(large)).toBeUndefined();
    expect(settle(large)).toBe(true);
    tool(large[0]!.entry);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
  });

  it("continues all accepted authority at the 32-member boundary", async () => {
    const items = Array.from({ length: 32 }, (_, index) => {
      vi.setSystemTime(Date.now() + 1);
      return child(`Boundary ${index}`);
    });
    tool(items[31]!.entry, 32);
    await adopt(items);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.messageId).toBe("existing-parent-card");
    expect(publications[0]!.content).toContain("Boundary 31");
    expect(publications[0]!.content).toContain("public-notes-32.txt");
  });

  it("rejects missing or cross-audience accepted members rather than adopting a partial batch", async () => {
    const first = child("First");
    const second = child("Second");
    second.entry.completionRequesterSessionId = "different-requester-window";
    expect(await continuation([first, second])).toBeUndefined();
    subagentRuns.delete(second.entry.runId);
    expect(await continuation([first, second])).toBeUndefined();
  });

  registerTaskProgressAuthorityTests({
    requesterSessionKey: PARENT,
    origin,
    child,
    adopt,
    runtime,
    publications,
    receipts,
    tool,
  });
});
