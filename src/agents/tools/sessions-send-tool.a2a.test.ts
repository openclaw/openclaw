import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
    __testing.setHelpersForTest({
      createEventSink: () => ({ append: async () => {} }),
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    __testing.setHelpersForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });
});

describe("sessions_send A2A envelope wiring", () => {
  it("builds a structured delegate task envelope from sessions_send params", () => {
    const envelope = __testing.buildTaskEnvelopeForTest({
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Investigate the latest failure and report back",
      announceTimeoutMs: 15_000,
      maxPingPongTurns: 2,
      waitRunId: "run-a2a-1",
    });

    expect(envelope).toMatchObject({
      v: 1,
      taskId: "run-a2a-1",
      kind: "delegate_task",
      requester: {
        sessionKey: "agent:main:discord:group:req",
        channel: "discord",
      },
      target: {
        sessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
      },
      task: {
        intent: "delegate",
        instructions: "Investigate the latest failure and report back",
        expectedOutput: { format: "text" },
      },
      constraints: {
        timeoutSeconds: 15,
        maxPingPongTurns: 2,
        allowAnnounce: true,
      },
      trace: {
        parentRunId: "run-a2a-1",
        correlationId: "run-a2a-1",
      },
    });
  });
});
