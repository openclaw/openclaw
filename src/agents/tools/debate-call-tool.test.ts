/**
 * Tests for debate_call tool
 *
 * Run with: pnpm test src/agents/tools/debate-call-tool.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true, allow: ["*"] } },
        agents: { defaults: {} },
      }) as never,
  };
});

import { createDebateCallTool } from "./debate-call-tool.js";

describe("debate_call tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns error when proposer fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("Proposer failed"));

    const tool = createDebateCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      topic: "Test topic",
      proposer: { agent: "proposer", skill: "propose" },
      critics: [{ agent: "critic", skill: "critique" }],
      resolver: { agent: "resolver", skill: "resolve" },
      input: { test: true },
      rounds: 1,
    });

    expect(callGatewayMock).toHaveBeenCalled();
    const details = result.details as { status: string };
    expect(details).toMatchObject({ status: "error" });
  });

  it("calls proposer, critics, and resolver in sequence", async () => {
    // Proposer call
    callGatewayMock.mockResolvedValueOnce({ runId: "run-proposer" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                output: { proposal: "Test proposal" },
                confidence: 0.6,
                assumptions: ["Assumption 1"],
              }),
            },
          ],
        },
      ],
    }); // chat.history for proposer

    // Critic call
    callGatewayMock.mockResolvedValueOnce({ runId: "run-critic" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                flaws: ["Flaw 1"],
                alternatives: ["Alternative 1"],
                confidence: 0.8,
              }),
            },
          ],
        },
      ],
    }); // chat.history for critic

    // Refinement call
    callGatewayMock.mockResolvedValueOnce({ runId: "run-refine" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                output: { proposal: "Refined proposal" },
                confidence: 0.85,
                assumptions: ["Assumption 2"],
              }),
            },
          ],
        },
      ],
    }); // chat.history for refinement

    // Resolver call
    callGatewayMock.mockResolvedValueOnce({ runId: "run-resolver" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                output: { conclusion: "Final conclusion" },
                confidence: 0.9,
                assumptions: [],
              }),
            },
          ],
        },
      ],
    }); // chat.history for resolver

    const tool = createDebateCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      topic: "Test debate",
      proposer: { agent: "proposer", skill: "propose" },
      critics: [{ agent: "critic", skill: "critique" }],
      resolver: { agent: "resolver", skill: "resolve" },
      input: { test: true },
      rounds: 1,
      minConfidence: 0.9,
    });

    const resolvedDetails = result.details as {
      status: string;
      confidence: number;
      rounds: unknown[];
      confidenceHistory: number[];
    };
    expect(resolvedDetails).toMatchObject({
      status: "resolved",
      confidence: 0.9,
    });
    expect(resolvedDetails.rounds).toHaveLength(1);
    expect(resolvedDetails.confidenceHistory).toContain(0.6);
    expect(resolvedDetails.confidenceHistory).toContain(0.85);
  });

  it("stops early when confidence threshold reached", async () => {
    // Proposer with high confidence
    callGatewayMock.mockResolvedValueOnce({ runId: "run-proposer" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                output: { proposal: "High confidence proposal" },
                confidence: 0.98, // Exceeds minConfidence of 0.95
                assumptions: [],
              }),
            },
          ],
        },
      ],
    });

    // Resolver for early stop
    callGatewayMock.mockResolvedValueOnce({ runId: "run-resolver" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                output: { conclusion: "Early resolved" },
                confidence: 0.99,
                assumptions: [],
              }),
            },
          ],
        },
      ],
    });

    const tool = createDebateCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      topic: "Test early stop",
      proposer: { agent: "proposer", skill: "propose" },
      critics: [{ agent: "critic", skill: "critique" }],
      resolver: { agent: "resolver", skill: "resolve" },
      input: { test: true },
      rounds: 2,
      minConfidence: 0.95,
    });

    const earlyStopDetails = result.details as {
      status: string;
      confidence: number;
      rounds: unknown[];
    };
    // Should not have called critics (early stop)
    expect(earlyStopDetails).toMatchObject({
      status: "resolved",
      confidence: 0.99,
    });
    expect(earlyStopDetails.rounds).toHaveLength(0); // No critique rounds
  });
});
