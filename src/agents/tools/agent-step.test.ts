import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const createHandoffCapsuleMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../zk-handoff.js", () => ({
  createHandoffCapsule: (params: unknown) => createHandoffCapsuleMock(params),
}));
vi.mock("../zk-spawn-key.js", () => ({
  resolveZkSpawnKey: () => Buffer.from("test-zk-spawn-key-32-byte-value!", "utf8"),
}));

import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    createHandoffCapsuleMock.mockClear();
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed and changes were pushed." }],
        },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:child", limit: 50 },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older output" }] },
        { role: "assistant", content: [] },
        { role: "system", content: [{ type: "text", text: "Compaction" }] },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("uses canonical agent IDs in step handoff capsules", async () => {
    createHandoffCapsuleMock.mockReturnValue({
      header: {},
      capabilityProof: "proof",
      encryptedContext: "enc",
      contextIv: "iv",
      contextTag: "tag",
      handoffHash: "hash",
    });
    callGatewayMock
      .mockResolvedValueOnce({ runId: "run-1" }) // agent
      .mockResolvedValueOnce({ status: "ok" }) // agent.wait
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      }); // chat.history

    await runAgentStep({
      sessionKey: "agent:target123:main",
      sourceSessionKey: "agent:source456:sub",
      sourceChannel: "discord",
      sourceTool: "sessions_send",
      message: "ping",
      extraSystemPrompt: "sys",
      timeoutMs: 1000,
    });

    expect(createHandoffCapsuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAgentId: "source456",
        receiverAgentId: "target123",
      }),
    );
  });
});
