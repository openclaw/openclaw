import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AcpRuntimeError, formatAcpErrorChain } from "../acp/runtime/errors.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import type { sendMessage } from "./task-registry-delivery-runtime.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { getTaskById } from "./task-registry.js";
import {
  createTaskFixture,
  reloadTaskRegistryFromStoreAsync,
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "./task-registry.test-support.js";

const hoisted = vi.hoisted(() => ({ sendMessageMock: vi.fn<typeof sendMessage>() }));
vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
  prepareTaskControlUiSessionUrl: async () => () => undefined,
}));
const GUILDCHAT_ORIGIN = { channel: "guildchat", to: "guildchat:123" } as const;
let releaseHeartbeat: (() => void) | undefined;
let heartbeatFlushed = false;
const HEARTBEAT_FLUSH_REASON = "task-notification-test-flush";

async function flushHeartbeat() {
  heartbeatFlushed = false;
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: HEARTBEAT_FLUSH_REASON,
    coalesceMs: 0,
  });
  await waitForFast(() => expect(heartbeatFlushed).toBe(true));
}

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "guildchat",
}));

beforeEach(async () => {
  resetGatewayWorkAdmission();
  releaseHeartbeat = setHeartbeatWakeHandler(async (request) => {
    heartbeatFlushed ||= request.reason === HEARTBEAT_FLUSH_REASON;
    return { status: "ran", durationMs: 0 };
  });
  await flushHeartbeat();
});

afterEach(async () => {
  await flushHeartbeat();
  releaseHeartbeat?.();
  releaseHeartbeat = undefined;
  resetSystemEventsForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  hoisted.sendMessageMock.mockReset();
  resetGatewayWorkAdmission();
});

function waitForFast<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 1 });
}

async function settleNotifications(deliveries: ReturnType<typeof captureTaskDeliveryWork>) {
  await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
  await deliveries.settle();
}

function sentMessageCall() {
  const call = hoisted.sendMessageMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected notification sendMessage call");
  }
  return call[0];
}
it("delivers a concise terminal failure message without internal ACP chatter", async () => {
  await withTaskRegistryTempDir(async () => {
    using deliveries = captureTaskDeliveryWork();
    resetSystemEventsForTest();
    hoisted.sendMessageMock.mockResolvedValue({
      channel: "guildchat",
      to: "guildchat:123",
      via: "direct",
      mediaUrl: null,
    });

    createTaskFixture("acp", {
      requesterOrigin: GUILDCHAT_ORIGIN,
      childSessionKey: "agent:codex:acp:child",
      runId: "run-failure-terminal",
      task: "Write the file",
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
    await settleNotifications(deliveries);
    expect(hoisted.sendMessageMock).toHaveBeenCalledOnce();

    expect(sentMessageCall()).toMatchObject({
      channel: "guildchat",
      to: "guildchat:123",
      content:
        "Background task failed: ACP background task (run run-fail). Permission denied by ACP runtime",
    });
    expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
  });
});

it.each(["direct", "parent_session"] as const)(
  "bounds ACP failure notices on the %s route while retaining the full task error",
  async (surface) => {
    await withTaskRegistryTempDir(
      async () => {
        using deliveries = captureTaskDeliveryWork();
        resetSystemEventsForTest();
        hoisted.sendMessageMock.mockResolvedValue({
          channel: "guildchat",
          to: "guildchat:123",
          via: "direct",
          mediaUrl: null,
        });
        const task = createTaskFixture("acp", {
          ...(surface === "direct" ? { requesterOrigin: GUILDCHAT_ORIGIN } : {}),
          childSessionKey: "agent:main:acp:child",
          runId: "run-bounded-terminal",
          label: "Sign in",
          task: "Sign in",
          deliveryStatus: "pending",
        });
        const error = formatAcpErrorChain(
          new AcpRuntimeError(
            "ACP_TURN_FAILED",
            "The login link expired. Sign in again. " + "Provider diagnostic detail. ".repeat(60),
          ),
        );
        emitAgentEvent({
          runId: "run-bounded-terminal",
          stream: "lifecycle",
          data: { phase: "error", endedAt: Date.now(), error },
        });
        await settleNotifications(deliveries);
        expect(getTaskById(task.taskId)?.deliveryStatus).toBe(
          surface === "direct" ? "delivered" : "session_queued",
        );

        const content =
          surface === "direct" ? sentMessageCall().content : peekSystemEvents("agent:main:main")[0];
        resetTaskRegistryForTests({ persist: false });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        const stored = getTaskById(task.taskId);
        expect(stored?.error).toBe(error);
        expect(content).toContain("The login link expired. Sign in again.");
        expect(content).toHaveLength(
          "Background task failed: Sign in (run run-boun). ".length + 120,
        );
        expect(content).toMatch(/…$/u);
        if (surface === "parent_session") {
          expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
        }
      },
      { durableStore: true },
    );
  },
);
