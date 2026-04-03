import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: vi.fn().mockResolvedValue({
    channel: "discord",
    to: "channel:123",
  }),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn(),
  readLatestAssistantReply: vi.fn().mockResolvedValue("test reply"),
}));

import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";

describe("runSessionsSendA2AFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(resolveAnnounceTarget).mockResolvedValueOnce(undefined);
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
    expect(callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "send" }),
    );
  });
});