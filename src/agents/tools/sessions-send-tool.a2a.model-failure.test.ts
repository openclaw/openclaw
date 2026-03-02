import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const runAgentStepMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
vi.mock("./agent-step.js", () => ({
  runAgentStep: (params: unknown) => runAgentStepMock(params),
  readLatestAssistantReply: (params: unknown) => readLatestAssistantReplyMock(params),
}));

import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

describe("runSessionsSendA2AFlow model failure handling", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    runAgentStepMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
  });

  it("notifies requester when agent.wait returns error", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "error",
        error: "model not found: google/gemini-3-1-pro-preview",
      })
      .mockResolvedValueOnce({ runId: "notify-run-1", status: "accepted" });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:target:telegram",
      displayKey: "agent:target:telegram",
      message: "hello",
      announceTimeoutMs: 30_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:requester:whatsapp",
      requesterChannel: "whatsapp",
      waitRunId: "target-run-1",
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "target-run-1" }),
      }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: "agent:requester:whatsapp",
          channel: "webchat",
          lane: "nested",
          deliver: false,
        }),
      }),
    );
    expect(runAgentStepMock).not.toHaveBeenCalled();
    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
  });

  it("does not notify requester when requesterSessionKey is absent", async () => {
    callGatewayMock.mockResolvedValueOnce({
      status: "error",
      error: "model not found",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:target:telegram",
      displayKey: "agent:target:telegram",
      message: "hello",
      announceTimeoutMs: 30_000,
      maxPingPongTurns: 0,
      waitRunId: "target-run-1",
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
      }),
    );
    expect(runAgentStepMock).not.toHaveBeenCalled();
  });

  it("swallows requester-notification failures", async () => {
    callGatewayMock
      .mockResolvedValueOnce({ status: "error", error: "model not found" })
      .mockRejectedValueOnce(new Error("notify failed"));

    await expect(
      runSessionsSendA2AFlow({
        targetSessionKey: "agent:target:telegram",
        displayKey: "agent:target:telegram",
        message: "hello",
        announceTimeoutMs: 30_000,
        maxPingPongTurns: 0,
        requesterSessionKey: "agent:requester:whatsapp",
        requesterChannel: "whatsapp",
        waitRunId: "target-run-1",
      }),
    ).resolves.toBeUndefined();

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });
});
