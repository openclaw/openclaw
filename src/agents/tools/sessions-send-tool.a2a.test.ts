// sessions_send A2A tests cover reply delivery, same-session replies, delayed
// run-owned replies, and channel target/account routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return {
    runId,
    sessionId: "session-source",
    turnId: "turn-source",
    requested: { provider: "openai", model: "gpt-5.6-luna" },
    effective: {
      provider: "openai",
      model: "gpt-5.6-luna",
      responseModel: "gpt-5.6-luna",
    },
    successfulToolNames: ["message"],
    rerouted: false,
    terminalDisposition: "visible",
    sourceReplyDelivered: true,
  };
}

function firstMockArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0] as Record<string, unknown>;
}

describe("runSessionsSendA2AFlow reply delivery", () => {
  let gatewayCalls: CallGatewayOptions[];
  let sessionListRows: GatewaySessionListRow[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    sessionListRows = [];
    callGatewayMock.mockReset();
    const callGateway = async <T = Record<string, unknown>>(
      opts: CallGatewayOptions,
    ): Promise<T> => {
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
        } as T;
      }
      return {} as T;
    };
    callGatewayMock.mockImplementation(callGateway);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      callGateway: callGatewayMock,
      runId: "run-test",
      targetAgentId: "main",
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      requesterSessionKey: "agent:main:telegram:group:-100123:topic:554",
      requesterDeliveryGeneration: {
        ...requesterDeliveryGeneration,
        sessionKey: "agent:main:telegram:group:-100123:topic:554",
      },
      replyTimeoutMs: 10_000,
      reply: { status: "ok", replyText: "Worker completed successfully" },
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it.each([
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
      await runSessionsSendA2AFlow({
        callGateway: callGatewayMock,
        runId: "run-test",
        targetAgentId: "orion",
        targetSessionKey: "agent:orion:discord:channel:target-room",
        displayKey: "agent:orion:discord:channel:target-room",
        replyTimeoutMs: 10_000,
        requesterSessionKey: "agent:orion:discord:channel:target-room",
        requesterDeliveryGeneration: {
          ...requesterDeliveryGeneration,
          agentId: "orion",
          sessionKey: "agent:orion:discord:channel:target-room",
        },
        requesterChannel: "discord",
        reply: { status: "ok", replyText: reply },
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

    await runSessionsSendA2AFlow({
      callGateway: callGatewayMock,
      requesterDeliveryGeneration,
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      runId: "run-delayed-channel",
    });

    expect(firstMockArg(agentWaitMock, "agent run wait").params).toMatchObject({
      runId: "run-delayed-channel",
    });
    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Delayed channel reply");
    expect(sendParams.agentId).toBe("main");
    expect(sendParams).not.toHaveProperty("sessionKey");
  });

  it("does not deliver when the completed run has no reply", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "silent" },
    });

    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      runId: "run-silent",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("does not turn a missing original session generation into an unbound direct send", async () => {
    await runSessionsSendA2AFlow({
      runId: "run-test",
      targetAgentId: "main",
      targetSessionKey: requesterDeliveryGeneration.sessionKey,
      displayKey: requesterDeliveryGeneration.sessionKey,
      requesterSessionKey: requesterDeliveryGeneration.sessionKey,
      requesterChannel: "discord",
      replyTimeoutMs: 10_000,
      reply: { status: "ok", replyText: "Task complete" },
    });
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("does not start a turn or send for same-session replies from a different channel", async () => {
    await runSessionsSendA2AFlow({
      runId: "run-test",
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
      reply: { status: "ok", replyText: "Substantive channel reply" },
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("does not redeliver a delivered delayed source reply for a webchat requester", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "Already delivered source reply" },
      terminalReceipt: deliveredReceipt("run-delivered-source"),
    });

    await runSessionsSendA2AFlow({
      runId: "run-delivered-source",
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls).toEqual([]);
  });

  it("delivers an internal delayed reply once without bouncing it back to the target", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "Already delivered source reply" },
      terminalReceipt: deliveredReceipt("run-delivered-cross-session-source"),
    });

    await runSessionsSendA2AFlow({
      runId: "run-delivered-cross-session-source",
      targetAgentId: "main",
      targetSessionKey: "agent:main:webchat:direct:target",
      displayKey: "agent:main:webchat:direct:target",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:webchat:direct:requester",
      requesterChannel: "webchat",
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(firstMockArg(vi.mocked(runAgentStep), "agent step")).toMatchObject({
      sessionKey: "agent:main:webchat:direct:requester",
      message: "Already delivered source reply",
      sourceSessionKey: "agent:main:webchat:direct:target",
      sourceTool: "sessions_send",
    });
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
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
      await runSessionsSendA2AFlow({
        runId: "run-test",
        callGateway: callGatewayMock,
        requesterDeliveryGeneration: generation
          ? { ...requesterDeliveryGeneration, sessionKey }
          : undefined,
        targetAgentId: "main",
        targetSessionKey: sessionKey,
        displayKey: sessionKey,
        replyTimeoutMs: 10_000,
        requesterSessionKey: sessionKey,
        requesterChannel: "qa-channel",
        requesterOrigin: captured
          ? { channel: "qa-channel", to: "dm:alice", accountId: "default" }
          : undefined,
        reply: { status: "ok", replyText: "Delayed result for a session with no saved route" },
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
        expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
      }
    },
  );

  it("uses the projected delivery context for the Discord source account", async () => {
    const accountId = "thinker";
    const session = {
      key: "agent:main:discord:channel:target-room",
      agentId: "main",
      kind: "group",
      classification: "channel",
      channel: "discord",
      deliveryContext: {
        channel: "discord",
        to: "channel:target-room",
        accountId,
      },
    } satisfies GatewaySessionListRow;
    sessionListRows = [session];

    await runSessionsSendA2AFlow({
      callGateway: callGatewayMock,
      runId: "run-test",
      targetAgentId: "main",
      targetSessionKey: session.key,
      displayKey: session.key,
      requesterSessionKey: session.key,
      requesterDeliveryGeneration,
      replyTimeoutMs: 10_000,
      reply: { status: "ok", replyText: "Worker completed successfully" },
    });

    requireGatewayCall("sessions.describe");
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.accountId).toBe(accountId);
  });

  it("notifies the requester when accepted delivery ends with timeout", async () => {
    const wait = {
      status: "timeout",
      error: "target run failed after delivery acceptance",
      endedAt: 1,
    };
    agentWaitMock.mockResolvedValueOnce(wait);

    await runSessionsSendA2AFlow({
      targetAgentId: "worker",
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      runId: "run-lock-timeout",
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(firstMockArg(vi.mocked(runAgentStep), "agent step")).toMatchObject({
      sessionKey: "agent:main:discord:group:req",
      sourceSessionKey: "agent:worker:discord:group:dev",
      sourceTool: "sessions_send",
    });
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toContain("sessions_send delivery to");
    expect(stepInput.message).toContain("target run failed after delivery acceptance");
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("reports timeout after confirmed source delivery without recommending a resend", async () => {
    const wait = { status: "timeout", error: "backend stalled after sending", endedAt: 1 };
    agentWaitMock.mockResolvedValueOnce({
      ...wait,
      terminalReceipt: deliveredReceipt("run-failed-after-source-reply"),
    });

    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
      notifyRequesterOnWaitFailure: true,
      runId: "run-failed-after-source-reply",
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toContain(wait.error);
    expect(stepInput.message).toContain("final reply was already delivered");
    expect(stepInput.message).toContain("Do not resend");
    expect(stepInput.extraSystemPrompt).toContain("Do not resend");
    expect(gatewayCalls).toEqual([]);
  });

  it("keeps Gateway drain interruptions silent", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "timeout",
      timeoutPhase: "gateway_draining",
    });

    await runSessionsSendA2AFlow({
      targetAgentId: "worker",
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      runId: "run-still-working",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("keeps recoverable delayed wait errors silent", async () => {
    agentWaitMock.mockRejectedValueOnce(new Error("gateway closed (1006)"));

    await runSessionsSendA2AFlow({
      targetAgentId: "worker",
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      replyTimeoutMs: 10_000,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      runId: "run-wait-interrupted",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });
});
