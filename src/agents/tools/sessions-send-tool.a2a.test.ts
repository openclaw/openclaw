import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runAgentStep } from "./agent-step.js";
import type { GatewaySessionListRow } from "./sessions-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const agentWaitMock = vi.hoisted(() => vi.fn());
const requesterDeliveryGeneration = {
  agentId: "main",
  storePath: "/test/agents/main/sessions/sessions.json",
  sessionKey: "agent:main:discord:channel:target-room",
  sessionId: "session-source",
  lifecycleRevision: null,
};

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue(undefined),
}));

function deliveredReceipt(runId: string) {
  const model = { provider: "openai", model: "gpt-5.6-luna" };
  return {
    runId,
    sessionId: "session-source",
    turnId: "turn-source",
    requested: model,
    effective: { ...model, responseModel: model.model },
    successfulToolNames: ["message"],
    rerouted: false,
    terminalDisposition: "visible",
    sourceReplyDelivered: true,
  };
}

type FlowOptions = Parameters<typeof runSessionsSendA2AFlow>[0];
function runFlow(options: Partial<FlowOptions> = {}) {
  const targetSessionKey = options.targetSessionKey ?? requesterDeliveryGeneration.sessionKey;
  return runSessionsSendA2AFlow({
    targetAgentId: "main",
    runId: "run-test",
    replyTimeoutMs: 10_000,
    targetSessionKey,
    displayKey: targetSessionKey,
    requesterSessionKey: targetSessionKey,
    ...options,
  });
}
function runNotification(runId: string) {
  return runFlow({
    targetAgentId: "worker",
    targetSessionKey: "agent:worker:discord:group:dev",
    requesterSessionKey: "agent:main:discord:group:req",
    requesterChannel: "discord",
    notifyRequesterOnWaitFailure: true,
    runId,
  });
}
function deliveryTarget(sessionKey: string, agentId = "main") {
  return {
    callGateway: callGatewayMock,
    targetSessionKey: sessionKey,
    targetAgentId: agentId,
    requesterDeliveryGeneration: { ...requesterDeliveryGeneration, agentId, sessionKey },
  };
}
function visibleReply(text: string) {
  return {
    status: "ok" as const,
    replyText: text,
    terminalReply: { disposition: "visible" as const, text },
  };
}

describe("runSessionsSendA2AFlow reply delivery", () => {
  let gatewayCalls: CallGatewayOptions[];
  let sessionListRows: GatewaySessionListRow[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    sessionListRows = [];
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: CallGatewayOptions) => {
      if (opts.method === "agent.wait") {
        return await agentWaitMock(opts);
      }
      gatewayCalls.push(opts);
      if (opts.method === "sessions.describe") {
        const params = opts.params as { key: string; agentId?: string };
        return {
          session:
            sessionListRows.find(
              (row) => row.key === params.key && row.agentId === params.agentId,
            ) ?? null,
        };
      }
      return {};
    });
    vi.clearAllMocks();
    vi.mocked(runAgentStep).mockResolvedValue(undefined);
    agentWaitMock.mockReset().mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "Test reply" },
    });
  });

  function requireGatewayCall(method: string): CallGatewayOptions {
    const call = gatewayCalls.find((entry) => entry.method === method);
    if (!call) {
      throw new Error(`expected gateway call ${method}`);
    }
    return call;
  }
  function expectNoSend() {
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  }
  function expectNoDelivery() {
    expect(runAgentStep).not.toHaveBeenCalled();
    expectNoSend();
  }

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runFlow({
      ...deliveryTarget("agent:main:telegram:group:-100123:topic:554"),
      reply: visibleReply("Worker completed successfully"),
    });

    expect(requireGatewayCall("send").params).toMatchObject({
      to: "-100123",
      channel: "telegram",
      threadId: "554",
    });
  });

  it.each([
    {
      name: "visible literal NO_REPLY",
      reply: "NO_REPLY",
      expected: { message: "NO_REPLY", agentId: "orion" },
    },
    {
      name: "a generated voice note",
      reply:
        'The log says "Agent couldn\'t generate a response", but the retry succeeded.\nMEDIA:./generated.ogg\n[[audio_as_voice]]',
      expected: {
        message: 'The log says "Agent couldn\'t generate a response", but the retry succeeded.',
        mediaUrls: ["./generated.ogg"],
        agentId: "orion",
        asVoice: true,
      },
    },
  ])(
    "projects $name into the same-session source delivery contract",
    async ({ reply, expected }) => {
      await runFlow({
        ...deliveryTarget("agent:orion:discord:channel:target-room", "orion"),
        requesterChannel: "discord",
        reply: visibleReply(reply),
      });

      const sendParams = requireGatewayCall("send").params as Record<string, unknown>;
      expect(sendParams).toMatchObject(expected);
      expect(sendParams).not.toHaveProperty("sessionKey");
    },
  );

  it.each([
    { name: "successive wait timeouts", waits: [{ status: "timeout" }, { status: "timeout" }] },
    { name: "queued execution", waits: [{ status: "pending", timeoutPhase: "queue" }] },
    {
      name: "a retried provider error",
      waits: [{ status: "timeout", pendingError: true, error: "retrying provider" }],
    },
  ])("delivers a same-session reply after $name", async ({ waits }) => {
    for (const wait of waits) {
      agentWaitMock.mockResolvedValueOnce(wait);
    }
    agentWaitMock.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "Delayed channel reply" },
    });

    await runFlow({
      callGateway: callGatewayMock,
      requesterDeliveryGeneration,
      requesterChannel: "discord",
      runId: "run-delayed-channel",
    });

    expect(agentWaitMock.mock.calls[0]?.[0].params).toMatchObject({
      runId: "run-delayed-channel",
    });
    expect(runAgentStep).not.toHaveBeenCalled();
    const sendParams = requireGatewayCall("send").params;
    expect(sendParams).toMatchObject({
      channel: "discord",
      to: "channel:target-room",
      message: "Delayed channel reply",
      agentId: "main",
    });
    expect(sendParams).not.toHaveProperty("sessionKey");
  });

  it.each([
    { terminalReply: { disposition: "silent" as const }, replyText: "stale visible result" },
    {
      terminalReply: { disposition: "visible" as const, text: "HEARTBEAT_OK" },
      replyText: "HEARTBEAT_OK",
    },
  ])("does not deliver silent completion or the exact heartbeat acknowledgement", async (reply) => {
    await runFlow({
      requesterChannel: "discord",
      runId: "run-silent",
      reply: { status: "ok", ...reply },
    });

    expectNoDelivery();
  });

  it.each(["discord", "webchat"])(
    "does not send an unbound same-session reply to %s",
    async (requesterChannel) => {
      await runFlow({ requesterChannel, reply: visibleReply("Task complete") });
      expectNoDelivery();
    },
  );

  it.each([false, true])(
    "routes an already delivered reply with cross-session=%s",
    async (cross) => {
      agentWaitMock.mockResolvedValueOnce({
        status: "ok",
        terminalReply: { disposition: "visible", text: "Already delivered source reply" },
        terminalReceipt: deliveredReceipt("run-test"),
      });
      await runFlow({
        requesterChannel: "webchat",
        ...(cross
          ? {
              targetSessionKey: "agent:main:webchat:direct:target",
              requesterSessionKey: "agent:main:webchat:direct:requester",
            }
          : {}),
      });
      if (cross) {
        expect(runAgentStep).toHaveBeenCalledOnce();
        expect(vi.mocked(runAgentStep).mock.calls[0]?.[0]).toMatchObject({
          sessionKey: "agent:main:webchat:direct:requester",
          message: "Already delivered source reply",
          sourceSessionKey: "agent:main:webchat:direct:target",
          sourceTool: "sessions_send",
        });
        expectNoSend();
      } else {
        expect(runAgentStep).not.toHaveBeenCalled();
        expect(gatewayCalls).toEqual([]);
      }
    },
  );

  it.each(["draining", "disconnected"])("keeps %s waits silent", async (state) => {
    if (state === "draining") {
      agentWaitMock.mockResolvedValueOnce({ status: "timeout", timeoutPhase: "gateway_draining" });
    } else {
      agentWaitMock.mockRejectedValueOnce(new Error("gateway closed (1006)"));
    }
    await runNotification("run-wait-interrupted");
    expectNoDelivery();
  });

  it.each([
    { captured: false, generation: false },
    { captured: true, generation: true },
  ])(
    "uses a captured route without current route metadata only with generation custody (%j)",
    async ({ captured, generation }) => {
      const sessionKey = "agent:main:direct:alice";
      sessionListRows = [
        { key: sessionKey, agentId: "main", kind: "direct", classification: "channel" },
      ];
      await runFlow({
        callGateway: callGatewayMock,
        requesterDeliveryGeneration: generation
          ? { ...requesterDeliveryGeneration, sessionKey }
          : undefined,
        targetSessionKey: sessionKey,
        requesterChannel: "qa-channel",
        requesterOrigin: captured
          ? { channel: "qa-channel", to: "dm:alice", accountId: "default" }
          : undefined,
        reply: visibleReply("Delayed result for a session with no saved route"),
      });

      expect(runAgentStep).not.toHaveBeenCalled();
      if (generation) {
        expect(requireGatewayCall("send").params).toMatchObject({
          channel: "qa-channel",
          to: "dm:alice",
          accountId: "default",
          message: "Delayed result for a session with no saved route",
        });
      } else {
        expectNoSend();
      }
    },
  );

  it("uses the projected delivery context for the Discord source account", async () => {
    sessionListRows = [
      {
        key: requesterDeliveryGeneration.sessionKey,
        agentId: "main",
        kind: "group",
        classification: "channel",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "channel:target-room",
          accountId: "thinker",
        },
      },
    ];

    await runFlow({
      callGateway: callGatewayMock,
      requesterDeliveryGeneration,
      reply: visibleReply("Worker completed successfully"),
    });

    requireGatewayCall("sessions.describe");
    expect(requireGatewayCall("send").params).toMatchObject({
      channel: "discord",
      to: "channel:target-room",
      accountId: "thinker",
    });
  });

  it("notifies the requester when accepted delivery ends with timeout", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "timeout",
      error: "target run failed after delivery acceptance",
      endedAt: 1,
    });
    await runNotification("run-lock-timeout");

    expect(runAgentStep).toHaveBeenCalledOnce();
    const stepInput = vi.mocked(runAgentStep).mock.calls[0]![0];
    expect(stepInput).toMatchObject({
      sessionKey: "agent:main:discord:group:req",
      sourceSessionKey: "agent:worker:discord:group:dev",
      sourceTool: "sessions_send",
    });
    expect(stepInput.message).toContain("sessions_send delivery to");
    expect(stepInput.message).toContain("target run failed after delivery acceptance");
    expectNoSend();
  });

  it("reports timeout after confirmed source delivery without recommending a resend", async () => {
    const wait = { status: "timeout", error: "backend stalled after sending", endedAt: 1 };
    agentWaitMock.mockResolvedValueOnce({
      ...wait,
      terminalReceipt: deliveredReceipt("run-failed-after-source-reply"),
    });

    await runFlow({
      requesterChannel: "webchat",
      notifyRequesterOnWaitFailure: true,
      runId: "run-failed-after-source-reply",
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    const stepInput = vi.mocked(runAgentStep).mock.calls[0]![0];
    expect(stepInput.message).toContain(wait.error);
    expect(stepInput.message).toContain("final reply was already delivered");
    expect(stepInput.message).toContain("Do not resend");
    expect(stepInput.extraSystemPrompt).toContain("Do not resend");
    expect(gatewayCalls).toEqual([]);
  });
});
