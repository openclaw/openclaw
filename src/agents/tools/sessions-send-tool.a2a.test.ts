import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCallGateway,
  mockRunAgentStep,
  mockReadLatestAssistantReply,
  mockResolveAnnounceTarget,
} = vi.hoisted(() => {
  return {
    mockCallGateway: vi.fn(),
    mockRunAgentStep: vi.fn(),
    mockReadLatestAssistantReply: vi.fn(),
    mockResolveAnnounceTarget: vi.fn(),
  };
});

vi.mock("../../gateway/call.js", () => ({ callGateway: mockCallGateway }));
vi.mock("./agent-step.js", () => ({
  runAgentStep: mockRunAgentStep,
  readLatestAssistantReply: mockReadLatestAssistantReply,
}));
vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: mockResolveAnnounceTarget,
}));

import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const BASE_PARAMS = {
  targetSessionKey: "agent:main:discord:channel:999",
  displayKey: "agent:main:discord:channel:999",
  message: "Hello from A",
  announceTimeoutMs: 5_000,
  maxPingPongTurns: 3,
  requesterSessionKey: "agent:main:main",
};

describe("runSessionsSendA2AFlow — NO_REPLY termination (#29984)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAnnounceTarget.mockResolvedValue(null);
  });

  it("returns early without entering ping-pong when roundOneReply is NO_REPLY", async () => {
    await runSessionsSendA2AFlow({
      ...BASE_PARAMS,
      roundOneReply: "NO_REPLY",
    });

    // No runAgentStep calls at all — we must return before the ping-pong loop
    // and before the announce step when the initial reply is a silent reply.
    expect(mockRunAgentStep).not.toHaveBeenCalled();
  });

  it("returns early when roundOneReply is whitespace-padded NO_REPLY", async () => {
    await runSessionsSendA2AFlow({
      ...BASE_PARAMS,
      roundOneReply: "  NO_REPLY  ",
    });

    expect(mockRunAgentStep).not.toHaveBeenCalled();
  });

  it("breaks loop after one turn when requester replies NO_REPLY and does not bounce back", async () => {
    // Requester (session A) replies NO_REPLY to the target's substantive message.
    // The loop must break, preventing the NO_REPLY from being forwarded back.
    // The announce step still runs once at the end (latestReply unchanged =
    // "I have something to say"), so total calls = 1 (ping-pong) + 1 (announce) = 2.
    mockRunAgentStep.mockResolvedValueOnce("NO_REPLY"); // turn 1 — requester
    mockRunAgentStep.mockResolvedValueOnce(undefined); // announce step — no announcement

    await runSessionsSendA2AFlow({
      ...BASE_PARAMS,
      roundOneReply: "I have something to say",
    });

    expect(mockRunAgentStep).toHaveBeenCalledTimes(2);
  });

  it("runs all maxPingPongTurns and announce step when replies are substantive", async () => {
    // All 3 turns return substantive content; announce step runs at the end.
    mockRunAgentStep.mockResolvedValue("Sounds good, let me check.");

    await runSessionsSendA2AFlow({
      ...BASE_PARAMS,
      roundOneReply: "Initial reply from target",
    });

    // maxPingPongTurns = 3 calls in the loop + 1 announce step = 4 total.
    expect(mockRunAgentStep).toHaveBeenCalledTimes(4);
  });
});
