// sessions_send A2A tests cover announce delivery, same-session replies, delayed
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

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
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

describe("runSessionsSendA2AFlow announce delivery", () => {
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
      if (opts.method === "sessions.list") {
        return { sessions: sessionListRows } as T;
      }
      return {} as T;
    };
    callGatewayMock.mockImplementation(callGateway);
    vi.clearAllMocks();
    vi.mocked(runAgentStep).mockResolvedValue("Test announce reply");
    agentWaitMock.mockReset().mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "Test announce reply" },
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
      targetAgentId: "main",
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });

  it("bypasses the announce decider for same-session channel replies", async () => {
    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      roundOneReply: "Substantive channel reply",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Substantive channel reply");
    expect(sendParams.agentId).toBe("main");
    expect(sendParams).not.toHaveProperty("sessionKey");
  });

  it.each([
    {
      name: "plain text",
      reply: "The requested work is complete.",
      expected: {
        message: "The requested work is complete.",
        agentId: "orion",
      },
    },
    {
      name: "generated media",
      reply: "Your image is ready.\nMEDIA:./generated.png",
      expected: {
        message: "Your image is ready.",
        mediaUrls: ["./generated.png"],
        agentId: "orion",
      },
    },
    {
      name: "a generated voice note",
      reply: "Your voice note is ready.\nMEDIA:./generated.ogg\n[[audio_as_voice]]",
      expected: {
        message: "Your voice note is ready.",
        mediaUrls: ["./generated.ogg"],
        agentId: "orion",
        asVoice: true,
      },
    },
  ])("projects $name into the gateway announcement contract", async ({ reply, expected }) => {
    vi.mocked(runAgentStep).mockResolvedValueOnce(reply);

    await runSessionsSendA2AFlow({
      targetAgentId: "orion",
      targetSessionKey: "agent:orion:discord:channel:target-room",
      displayKey: "agent:orion:discord:channel:target-room",
      message: "Complete the requested work.",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:discord:channel:requester-room",
      requesterChannel: "discord",
      roundOneReply: "The target agent completed.",
    });

    const sendParams = requireGatewayCall("send").params as Record<string, unknown>;
    expect(sendParams).toMatchObject(expected);
    expect(sendParams).not.toHaveProperty("sessionKey");
  });

  it.each([
    { name: "immediate completion", waits: [] },
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
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      waitRunId: "run-delayed-channel",
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

  it("does not announce when the completed run has no reply", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "silent" },
    });

    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      waitRunId: "run-silent",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("delivers a legitimate reply that quotes incomplete-turn text", async () => {
    const reply = 'The log says "Agent couldn\'t generate a response", but the retry succeeded.';

    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Diagnose the failed turn",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      roundOneReply: reply,
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    expect((sendCall.params as Record<string, unknown>).message).toBe(reply);
  });

  it("keeps the announce decider for same-session sends from a different channel", async () => {
    vi.mocked(runAgentStep).mockResolvedValueOnce("ANNOUNCE_SKIP");

    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
      roundOneReply: "Substantive channel reply",
    });

    expect(runAgentStep).toHaveBeenCalledTimes(1);
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toBe("Agent-to-agent announce step.");
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it.each(["inline", "delayed"] as const)(
    "does not re-announce a delivered %s source reply for a webchat requester",
    async (mode) => {
      agentWaitMock.mockResolvedValueOnce({
        status: "ok",
        terminalReply: { disposition: "visible", text: "Already delivered source reply" },
        terminalReceipt: deliveredReceipt("run-delivered-source"),
      });

      await runSessionsSendA2AFlow({
        targetAgentId: "main",
        targetSessionKey: "agent:main:discord:channel:target-room",
        displayKey: "agent:main:discord:channel:target-room",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:channel:target-room",
        requesterChannel: "webchat",
        ...(mode === "inline"
          ? { roundOneReply: "Already delivered source reply", sourceReplyDelivered: true as const }
          : { waitRunId: "run-delivered-source" }),
      });

      expect(runAgentStep).not.toHaveBeenCalled();
      expect(gatewayCalls).toEqual([]);
    },
  );

  it("does not run the announce decider for same-session sends without an announce target", async () => {
    await runSessionsSendA2AFlow({
      targetAgentId: "main",
      targetSessionKey: "agent:main:main",
      displayKey: "agent:main:main",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "qa-channel",
      roundOneReply: "Already delivered through the source message tool",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("uses the projected delivery context for the Discord announce account", async () => {
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
      targetAgentId: "main",
      targetSessionKey: session.key,
      displayKey: session.key,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    requireGatewayCall("sessions.list");
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.accountId).toBe(accountId);
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "does not re-inject exact control reply %s into agent-to-agent flow",
    async (roundOneReply) => {
      await runSessionsSendA2AFlow({
        targetAgentId: "main",
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:group:req",
        requesterChannel: "discord",
        roundOneReply,
      });

      expect(runAgentStep).not.toHaveBeenCalled();
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );

  it.each([
    {
      status: "timeout",
      error: "target run failed after delivery acceptance",
      endedAt: 1,
    },
    {
      status: "error",
      error: "target run failed after delivery acceptance\nstderr: socket hang up",
    },
  ] as const)("notifies the requester when accepted delivery ends with $status", async (wait) => {
    agentWaitMock.mockResolvedValueOnce(wait);

    await runSessionsSendA2AFlow({
      targetAgentId: "worker",
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      waitRunId: "run-lock-timeout",
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

  it.each([
    { status: "error", error: "backend exited after sending" },
    { status: "timeout", error: "backend stalled after sending", endedAt: 1 },
  ] as const)(
    "reports $status after confirmed source delivery without recommending a resend",
    async (wait) => {
      agentWaitMock.mockResolvedValueOnce({
        ...wait,
        terminalReceipt: deliveredReceipt("run-failed-after-source-reply"),
      });

      await runSessionsSendA2AFlow({
        targetAgentId: "main",
        targetSessionKey: "agent:main:discord:channel:target-room",
        displayKey: "agent:main:discord:channel:target-room",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:channel:target-room",
        requesterChannel: "webchat",
        notifyRequesterOnWaitFailure: true,
        waitRunId: "run-failed-after-source-reply",
      });

      expect(runAgentStep).toHaveBeenCalledOnce();
      const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
      expect(stepInput.message).toContain(wait.error);
      expect(stepInput.message).toContain("final reply was already delivered");
      expect(stepInput.message).toContain("Do not resend");
      expect(stepInput.extraSystemPrompt).toContain("Do not resend");
      expect(gatewayCalls).toEqual([]);
    },
  );

  it("does not notify the requester for waited sends that already returned the error inline", async () => {
    agentWaitMock.mockResolvedValueOnce({
      status: "timeout",
      error: "target run failed after delivery acceptance",
      endedAt: 1,
    });

    await runSessionsSendA2AFlow({
      targetAgentId: "worker",
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      waitRunId: "run-lock-timeout-inline",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
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
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      waitRunId: "run-still-working",
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
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      waitRunId: "run-wait-interrupted",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("skips requester steps when ping-pong is disabled but still announces from the target", async () => {
    const targetSessionKey = "agent:other:discord:group:ops";

    await runSessionsSendA2AFlow({
      targetAgentId: "other",
      targetSessionKey,
      displayKey: targetSessionKey,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:cron:job:run:abc",
      requesterChannel: "telegram",
      roundOneReply: "Worker completed successfully",
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(firstMockArg(vi.mocked(runAgentStep), "agent step")).toMatchObject({
      sessionKey: targetSessionKey,
      message: "Agent-to-agent announce step.",
    });
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP"])(
    "suppresses exact announce control reply %s before channel delivery",
    async (announceReply) => {
      vi.mocked(runAgentStep).mockResolvedValueOnce(announceReply);

      await runSessionsSendA2AFlow({
        targetAgentId: "main",
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        roundOneReply: "Worker completed successfully",
      });

      const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
      expect(stepInput.message).toBe("Agent-to-agent announce step.");
      expect(stepInput.transcriptMessage).toBe("");
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );
});
