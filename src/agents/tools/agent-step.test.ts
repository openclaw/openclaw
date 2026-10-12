// Agent step tests cover nested session handoff and
// MCP runtime survival after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { runAgentStep } from "./agent-step.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

const agentWaitMock = vi.hoisted(() => vi.fn());

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

describe("runAgentStep", () => {
  afterEach(() => {
    agentWaitMock.mockReset();
    vi.clearAllMocks();
  });

  it("preserves bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      if (opts.method === "agent.wait") {
        return await agentWaitMock(opts);
      }
      gatewayCalls.push(opts);
      return { runId: "run-nested" } as T;
    };
    agentWaitMock.mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "done" },
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        agentId: "main",
        sourceAgentId: "research",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();

    const params = gatewayCalls[0]?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(recordParticipant).toHaveBeenCalledOnce();
    expect(recordParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { type: "agent", id: "research" },
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        promptedAt: expect.any(Number),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("waits for the nested reply through queued and nonterminal timeout observations", async () => {
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> =>
      opts.method === "agent.wait" ? await agentWaitMock(opts) : ({ runId: "run-pending" } as T);
    agentWaitMock
      .mockResolvedValueOnce({ status: "pending", timeoutPhase: "queue" })
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({
        status: "ok",
        terminalReply: { disposition: "visible", text: "late reply" },
      });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();
    expect(agentWaitMock).toHaveBeenCalledTimes(3);

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });
});
