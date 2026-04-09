import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
  readLatestAssistantReply: vi.fn().mockResolvedValue("test reply"),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: vi.fn().mockResolvedValue({
    channel: "discord",
    to: "channel:123",
  }),
}));

import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";

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
  });

  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    vi.mocked(resolveAnnounceTarget).mockResolvedValueOnce({
      channel: "telegram",
      to: "-100123",
      threadId: "554",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    // Find the gateway send call (not the waitForAgentRun call)
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

describe("runSessionsSendA2AFlow lanes and fallback", () => {
  const callGatewayMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        callGatewayMock(opts);
        return {} as T;
      },
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("uses AGENT_LANE_NESTED for ping-pong step", async () => {
    (runAgentStep as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("ping-pong reply")
      .mockResolvedValueOnce(undefined); // announce step

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 1,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord",
      roundOneReply: "initial reply", // Required to avoid early return
    });

    // Verify ping-pong used AGENT_LANE_NESTED
    const pingPongCall = (runAgentStep as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pingPongCall[0]?.lane).toBe(AGENT_LANE_NESTED);
  });

  it("uses lane 'announce' for announce step", async () => {
    (runAgentStep as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("ping-pong reply")
      .mockResolvedValueOnce("announce reply");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 1,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord",
      roundOneReply: "initial reply",
    });

    // Verify announce used 'announce' lane
    const announceCall = (runAgentStep as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(announceCall[0]?.lane).toBe("announce");
  });

  it("sends deterministic fallback when announce step returns undefined", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    // When maxPingPongTurns=0, there's no ping-pong loop, so first call is announce step
    (runAgentStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined); // announce timeout/deadlock

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord",
      roundOneReply: "primary reply",
    });

    // Verify send was called with deterministic fallback
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({
          channel: "discord",
          to: "channel:123",
        }),
      }),
    );

    const sendCall = callGatewayMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "send",
    );
    const sentMessage = (sendCall?.[0] as { params?: { message?: string } })?.params?.message;

    expect(sentMessage).toMatch(/^\[Task completed\]/);
    expect(sentMessage).toContain("Agent: agent:worker:main");
    expect(sentMessage).toContain("Channel: discord");
    expect(sentMessage).toContain("Summary:");
    expect(sentMessage).toMatch(/Completed: \d{4}-\d{2}-\d{2}T/);
  });

  it("uses LLM-generated message when announce step succeeds", async () => {
    const llmMessage = "Custom LLM-generated announce message";
    callGatewayMock.mockResolvedValue({ status: "ok" });
    // When maxPingPongTurns=0, first call is the announce step
    (runAgentStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(llmMessage);

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord",
      roundOneReply: "primary reply",
    });

    const sendCall = callGatewayMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "send",
    );
    const sentMessage = (sendCall?.[0] as { params?: { message?: string } })?.params?.message;

    expect(sentMessage).toBe(llmMessage);
    expect(sentMessage).not.toMatch(/^\[Task completed\]/);
  });

  it("includes last 200 chars of latestReply in fallback summary", async () => {
    const longReply = "A".repeat(300);
    callGatewayMock.mockResolvedValue({ status: "ok" });
    // When maxPingPongTurns=0, first call is the announce step (undefined = timeout)
    (runAgentStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:main",
      requesterChannel: "discord",
      roundOneReply: longReply,
    });

    const sendCall = callGatewayMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "send",
    );
    const sentMessage = (sendCall?.[0] as { params?: { message?: string } })?.params?.message;

    // Should contain last 200 chars (not 300)
    expect(sentMessage).toContain("Summary: " + "A".repeat(200));
    expect(sentMessage).not.toContain("Summary: " + "A".repeat(250));
  });

  it("does not send when announceTarget is undefined (no fallback)", async () => {
    vi.mocked(resolveAnnounceTarget).mockResolvedValueOnce(null);
    (runAgentStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce("reply");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "test message",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
      roundOneReply: "reply",
    });

    // No send should be called when announceTarget is undefined
    expect(callGatewayMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: "send" }));
  });
});
