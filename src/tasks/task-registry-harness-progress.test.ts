import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import type { sendMessage as SendMessage } from "./task-registry-delivery-runtime.js";
import { registerHarnessTaskProgress } from "./task-registry-harness-progress.js";
import { createTaskRecord, getTaskById, markTaskTerminalById } from "./task-registry.js";
import { clearTaskProgressBatches } from "./task-registry.process-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
}));

const sendMessage = vi.hoisted(() => vi.fn<typeof SendMessage>());
const editTaskProgressMessage = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const prepareTaskProgressPreferenceReader = vi.hoisted(() =>
  vi.fn(
    async (_assertCurrent: () => void) =>
      (_channel?: string, _accountId?: string): boolean =>
        true,
  ),
);
vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage,
  editTaskProgressMessage,
  prepareTaskProgressPreferenceReader,
  prepareTaskControlUiSessionUrl: async () => () => undefined,
}));

const PARENT = "agent:main:parent";
const origin = {
  channel: "notifychat",
  to: "synthetic-recipient",
  accountId: "test",
  threadId: "test-thread",
};

function child(name: string, options: { notifyPolicy?: TaskNotifyPolicy } = {}) {
  const task = createTaskRecord({
    runtime: "subagent",
    ownerKey: PARENT,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    scopeKind: "session",
    childSessionKey: `agent:main:subagent:${name}`,
    runId: `run-${name}`,
    label: name,
    task: "Private child assignment",
    status: "running",
    notifyPolicy: options.notifyPolicy ?? "state_changes",
    deliveryStatus: "pending",
    requesterOrigin: { ...origin },
  });
  if (!task) {
    throw new Error("Expected accepted task");
  }
  return { task };
}
type Child = ReturnType<typeof child>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  sendMessage.mockReset().mockImplementation(async (params) => {
    await params.onPlatformSendDispatch?.();
    params.assertDirectAdapterHandoff?.();
    return { channel: origin.channel, to: params.to, via: "direct", mediaUrl: null };
  });
  editTaskProgressMessage.mockReset().mockResolvedValue(undefined);
  prepareTaskProgressPreferenceReader.mockReset().mockImplementation(async () => () => true);
});

afterEach(() => {
  clearTaskProgressBatches();
  resetTaskRegistryForTests({ persist: false });
  vi.useRealTimers();
});

describe("yield-authorized harness progress", () => {
  function register(item: Child, isCurrent: () => boolean = () => true) {
    const stopped = vi.fn();
    const progress = registerHarnessTaskProgress({
      readTasks: () => {
        const current = getTaskById(item.task.taskId);
        return current ? [current] : [];
      },
      isCurrent,
      owner: { sessionKey: PARENT, agentId: "main", requesterOrigin: origin },
      onStopped: stopped,
    });
    return { progress, stopped };
  }

  function nativeDelivery(messageId = "native-progress-card") {
    return {
      channel: origin.channel,
      to: origin.to,
      via: "direct" as const,
      mediaUrl: null,
      result: {
        channel: origin.channel,
        messageId,
        target: { kind: "channel" as const, id: "native-thread" },
      },
    };
  }

  it("sends once and edits that card through terminal task state without a completion announcement", async () => {
    const item = child("Native", { notifyPolicy: "silent" });
    const stopped = vi.fn();
    sendMessage.mockImplementationOnce(async (params) => {
      await params.onPlatformSendDispatch?.();
      params.assertDirectAdapterHandoff?.();
      return {
        channel: origin.channel,
        to: params.to,
        via: "direct",
        mediaUrl: null,
        result: {
          channel: origin.channel,
          messageId: "native-progress-card",
          target: { kind: "channel", id: "native-thread" },
        },
      };
    });
    const progress = registerHarnessTaskProgress({
      readTasks: () => {
        const current = getTaskById(item.task.taskId);
        return current ? [current] : [];
      },
      isCurrent: () => true,
      owner: { sessionKey: PARENT, agentId: "main", requesterOrigin: origin },
      onStopped: stopped,
    });
    expect(progress).toBeDefined();
    progress?.notify();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();

    markTaskTerminalById({ taskId: item.task.taskId, status: "succeeded", endedAt: Date.now() });
    progress?.notify();
    // Terminal state bypasses the coalescer so a resumed requester cannot retire it first.
    await vi.advanceTimersByTimeAsync(0);
    expect(editTaskProgressMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: "native-progress-card",
        content: expect.stringContaining("succeeded"),
      }),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(JSON.stringify(editTaskProgressMessage.mock.calls)).not.toContain(
      "private-tool-arguments",
    );
  });

  it.each(["send", "edit"] as const)(
    "publishes terminal state after an in-flight harness %s settles",
    async (phase) => {
      const item = child(`Native ${phase}`, { notifyPolicy: "silent" });
      const entered = createDeferred();
      const release = createDeferred();
      if (phase === "send") {
        sendMessage.mockImplementationOnce(async (params) => {
          entered.resolve();
          await release.promise;
          await params.onPlatformSendDispatch?.();
          params.assertDirectAdapterHandoff?.();
          return nativeDelivery();
        });
      } else {
        sendMessage.mockImplementationOnce(async (params) => {
          await params.onPlatformSendDispatch?.();
          params.assertDirectAdapterHandoff?.();
          return nativeDelivery();
        });
        editTaskProgressMessage.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      const { progress, stopped } = register(item);
      expect(progress).toBeDefined();
      progress?.notify();
      await vi.advanceTimersByTimeAsync(15_000);
      if (phase === "edit") {
        markTaskTerminalById({
          taskId: item.task.taskId,
          status: "succeeded",
          endedAt: Date.now(),
        });
        progress?.notify();
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await entered.promise;
      if (phase === "send") {
        markTaskTerminalById({
          taskId: item.task.taskId,
          status: "succeeded",
          endedAt: Date.now(),
        });
      }
      progress?.notify();
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(editTaskProgressMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining("succeeded") }),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(stopped).toHaveBeenCalledOnce();
    },
  );

  it("retires the presentation owner when task progress batches are cleared", async () => {
    const item = child("Native reset", { notifyPolicy: "silent" });
    const { progress, stopped } = register(item);
    expect(progress).toBeDefined();
    progress?.notify();
    clearTaskProgressBatches();
    expect(stopped).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    progress?.notify();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById(item.task.taskId)?.status).toBe("running");
  });

  it.each(["notify", "timer", "handoff"] as const)(
    "revokes an invalid nonterminal owner at the %s boundary",
    async (boundary) => {
      const item = child(`Native ${boundary}`, { notifyPolicy: "silent" });
      let current = true;
      const { progress, stopped } = register(item, () => current);
      expect(progress).toBeDefined();
      if (boundary === "handoff") {
        sendMessage.mockImplementationOnce(async (params) => {
          current = false;
          await params.onPlatformSendDispatch?.();
          params.assertDirectAdapterHandoff?.();
          return nativeDelivery();
        });
      }
      progress?.notify();
      if (boundary !== "handoff") {
        current = false;
      }
      if (boundary === "notify") {
        progress?.notify();
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stopped).toHaveBeenCalledOnce();
      progress?.notify();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stopped).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledTimes(boundary === "handoff" ? 1 : 0);
    },
  );

  it("stops without sending when the progress-tool preference is disabled", async () => {
    prepareTaskProgressPreferenceReader.mockImplementationOnce(async () => () => false);
    const item = child("Native disabled", { notifyPolicy: "silent" });
    const { progress, stopped } = register(item);
    expect(progress).toBeDefined();
    progress?.notify();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
  });
});
