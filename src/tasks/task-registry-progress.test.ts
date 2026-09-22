import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "../agents/subagents/registry/subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import * as deliveryRuntime from "./task-registry-runtime-loaders.js";
import { resetTaskRegistryListenerState } from "./task-registry-state.js";
import {
  createTaskRecord,
  getTaskById,
  markTaskTerminalById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
}));

const PARENT = "agent:main:parent";
const origin = {
  channel: "notifychat",
  to: "synthetic-recipient",
  accountId: "test",
  threadId: "test-thread",
};
const sendMessage = vi.fn<deliveryRuntime.TaskRegistryDeliveryRuntime["sendMessage"]>();

function child(name: string, notifyPolicy: TaskNotifyPolicy = "state_changes") {
  const entry: SubagentRunRecord = {
    runId: `run-${name}`,
    childSessionKey: `agent:main:subagent:${name}`,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    requesterDisplayKey: PARENT,
    requesterTurnRunId: "parent-turn",
    requesterTurnYielded: true,
    requesterOrigin: origin,
    task: "Private child assignment",
    label: name,
    cleanup: "keep",
    createdAt: Date.now(),
    generation: 1,
    execution: { status: "running", startedAt: Date.now() },
    expectsCompletionMessage: true,
  };
  subagentRuns.set(entry.runId, entry);
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
    notifyPolicy,
    deliveryStatus: "pending",
    requesterOrigin: origin,
    detail: createSubagentTaskBackingDetail(1),
  });
  if (!task) {
    throw new Error("Expected accepted task");
  }
  return { entry, task };
}

function yieldParent() {
  const entries = [...subagentRuns.values()];
  expect(
    settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: PARENT,
      requesterTurnRunId: "parent-turn",
      requesterYielded: true,
      acceptedSessionSpawns: entries.map((entry) => ({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        expectsCompletionMessage: true,
      })),
      runs: subagentRuns,
      persistOrThrow: () => {},
      schedule: () => {},
    }),
  ).toBe(true);
}

function tool(entry: SubagentRunRecord, index = 1) {
  emitAgentEvent({
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    stream: "tool",
    data: {
      phase: "start",
      name: "read",
      toolCallId: `call-${index}`,
      args: { secret: "private-tool-arguments" },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  subagentRuns.clear();
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  sendMessage.mockReset().mockImplementation(async (params) => {
    params.assertDirectAdapterHandoff?.();
    return {
      channel: "notifychat",
      to: params.to,
      via: "direct",
      mediaUrl: null,
      deliveryStatus: "sent",
    };
  });
  setTaskRegistryDeliveryRuntimeForTests({ sendMessage });
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryDeliveryRuntimeForTests();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  subagentRuns.clear();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("yielded subagent progress delivery", () => {
  it("coalesces the yield handoff and child activity at the original audience without completing or waking the parent", async () => {
    const first = child("First");
    vi.setSystemTime(Date.now() + 1);
    const second = child("Second");
    child("Quiet", "silent");
    // The slow tool starts before the parent yields and need not produce another event.
    tool(first.entry);
    yieldParent();
    for (let index = 0; index < 40; index++) {
      tool(second.entry, index);
    }
    emitAgentEvent({
      runId: first.entry.runId,
      stream: "assistant",
      data: { text: "private-child-text" },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]![0];
    expect(message).toMatchObject({
      ...origin,
      skipQueue: true,
      gatewayOwnedDelivery: true,
      mirror: { sessionKey: PARENT, agentId: "main" },
    });
    expect(message.content).toBe(
      "Background work is still in progress:\n- First: running read; 1 tool call started.\n- Second: running read; 40 tool calls started.",
    );
    expect(message.content).not.toMatch(/Quiet|private-/);
    expect(getTaskById(first.task.taskId)).toMatchObject({
      status: "running",
      deliveryStatus: "pending",
    });
    expect(first.entry.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(peekSystemEvents(PARENT)).toEqual([]);
  });

  it.each(["done_only", "silent"] as const)(
    "preserves %s notification policy across yield",
    async (policy) => {
      const item = child("Worker", policy);
      yieldParent();
      tool(item.entry);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "finish", "rearm", "replace", "resume", "mute", "drain", "reset"] as const)(
    "drops queued progress after %s",
    async (change) => {
      const item = child("Worker");
      tool(item.entry);
      yieldParent();
      switch (change) {
        case "cancel":
          item.entry.killIntent = { requestedAt: Date.now(), reason: "operator cancelled" };
          break;
        case "finish":
          markTaskTerminalById({
            taskId: item.task.taskId,
            status: "succeeded",
            endedAt: Date.now(),
          });
          break;
        case "rearm":
          item.entry.requesterSettleWake!.rearmGeneration = 2;
          break;
        case "replace":
          subagentRuns.set(item.entry.runId, { ...item.entry, generation: 2 });
          break;
        case "resume":
          registerAgentRunContext("parent-resumed", {
            sessionKey: PARENT,
            agentId: "main",
            projectSessionActive: true,
          });
          break;
        case "mute":
          updateTaskNotifyPolicyById({ taskId: item.task.taskId, notifyPolicy: "silent" });
          break;
        case "drain":
          markGatewayRestartDraining();
          break;
        case "reset":
          resetTaskRegistryListenerState();
          break;
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("revalidates after runtime loading and at adapter handoff", async () => {
    const first = child("First");
    yieldParent();
    const loaded = createDeferred<deliveryRuntime.TaskRegistryDeliveryRuntime>();
    vi.spyOn(deliveryRuntime, "loadTaskRegistryDeliveryRuntime").mockReturnValueOnce(
      loaded.promise,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    first.entry.killIntent = { requestedAt: Date.now(), reason: "cancelled during load" };
    loaded.resolve({ sendMessage });
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).not.toHaveBeenCalled();

    subagentRuns.clear();
    const second = child("Second");
    yieldParent();
    let visibleSends = 0;
    sendMessage.mockImplementationOnce(async (params) => {
      second.entry.requesterSettleWake = undefined;
      params.assertDirectAdapterHandoff?.();
      visibleSends++;
      return { channel: "notifychat", to: params.to, via: "direct", mediaUrl: null };
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(visibleSends).toBe(0);
    expect(getTaskById(second.task.taskId)?.deliveryStatus).toBe("pending");
  });

  it("bounds a large batch and keeps publishing when newer activity arrives during transport work", async () => {
    const items = Array.from({ length: 35 }, (_, index) => {
      vi.setSystemTime(Date.now() + 1);
      return child(`Worker ${index + 1}`);
    });
    yieldParent();
    const first = items[0]!;
    sendMessage.mockImplementationOnce(async (params) => {
      tool(first.entry);
      params.assertDirectAdapterHandoff?.();
      return { channel: "notifychat", to: params.to, via: "direct", mediaUrl: null };
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].content.split("\n")).toHaveLength(10);
    expect(sendMessage.mock.calls[0]![0].content).toContain(
      "More task activity is available in Tasks.",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![0].content).toContain(
      "Worker 1: running read; 1 tool call started.",
    );
  });
});
