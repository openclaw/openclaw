import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { __testing, readLatestAssistantReply, runAgentStep } from "./agent-step.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
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

  it("uses configured gateway rpc and settle timeouts for nested agent steps", async () => {
    const config = {
      gateway: {
        timeoutMs: 12_000,
        sessionSettleTimeoutMs: 7_000,
      },
    } satisfies OpenClawConfig;
    callGatewayMock
      .mockResolvedValueOnce({ runId: "run-step-1" })
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "step reply" }],
          },
        ],
      });

    const result = await runAgentStep({
      sessionKey: "agent:main:child",
      message: "status",
      extraSystemPrompt: "step prompt",
      timeoutMs: 30_000,
      config,
    });

    expect(result).toBe("step reply");
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      timeoutMs: 12_000,
    });
    expect(callGatewayMock.mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "run-step-1", timeoutMs: 30_000 },
      timeoutMs: 37_000,
    });
  });
});
