import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { runAgentStep } from "./agent-step.js";

describe("runAgentStep", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("uses finalAssistantText from agent.wait without chat.history fallback", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok", finalAssistantText: "reply from wait" };
      }
      if (request.method === "chat.history") {
        throw new Error("chat.history should not be called when wait reply is available");
      }
      return {};
    });

    const reply = await runAgentStep({
      sessionKey: "agent:coder:test",
      message: "ping",
      extraSystemPrompt: "step",
      timeoutMs: 5_000,
    });
    expect(reply).toBe("reply from wait");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "chat.history",
      ),
    ).toBe(false);
  });

  it("falls back to chat.history when agent.wait has no finalAssistantText", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-2" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "reply from history" }],
            },
          ],
        };
      }
      return {};
    });

    const reply = await runAgentStep({
      sessionKey: "agent:coder:test",
      message: "ping",
      extraSystemPrompt: "step",
      timeoutMs: 5_000,
    });
    expect(reply).toBe("reply from history");
  });

  it("returns undefined when agent.wait does not finish with ok", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-3" };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "chat.history") {
        throw new Error("chat.history should not be called for non-ok wait status");
      }
      return {};
    });

    const reply = await runAgentStep({
      sessionKey: "agent:coder:test",
      message: "ping",
      extraSystemPrompt: "step",
      timeoutMs: 5_000,
    });
    expect(reply).toBeUndefined();
  });
});
