import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
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
});

describe("runAgentStep", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("propagates timeout to target agent runs while preserving wait timing", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ready" }],
            },
          ],
        };
      }
      return {};
    });

    const result = await runAgentStep({
      sessionKey: "agent:main:child",
      message: "hello",
      extraSystemPrompt: "context",
      timeoutMs: 45_000,
      sourceSessionKey: "agent:main:parent",
      sourceChannel: "discord",
    });

    expect(result).toBe("ready");
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        sessionKey: "agent:main:child",
        message: "hello",
        timeout: "45",
      },
      timeoutMs: 10_000,
    });
    expect(callGatewayMock.mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: {
        runId: "run-1",
        timeoutMs: 45_000,
      },
      timeoutMs: 47_000,
    });
  });

  it.each([
    { timeoutMs: 1, expectedTimeout: "1" },
    { timeoutMs: 1001, expectedTimeout: "2" },
  ])(
    "clamps and rounds target timeout for timeoutMs=$timeoutMs",
    async ({ timeoutMs, expectedTimeout }) => {
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-boundary" };
        }
        if (request.method === "agent.wait") {
          return { status: "ok" };
        }
        if (request.method === "chat.history") {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "ready" }],
              },
            ],
          };
        }
        return {};
      });

      const result = await runAgentStep({
        sessionKey: "agent:main:child",
        message: "hello",
        extraSystemPrompt: "context",
        timeoutMs,
        sourceSessionKey: "agent:main:parent",
        sourceChannel: "discord",
      });

      expect(result).toBe("ready");
      expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({
        method: "agent",
        params: {
          sessionKey: "agent:main:child",
          timeout: expectedTimeout,
        },
      });
      expect(callGatewayMock.mock.calls[1]?.[0]).toMatchObject({
        method: "agent.wait",
        params: {
          runId: "run-boundary",
          timeoutMs,
        },
        timeoutMs: timeoutMs + 2000,
      });
    },
  );
});
