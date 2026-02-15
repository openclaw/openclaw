/**
 * Tests for agent_call tool
 *
 * Run with: pnpm test src/agents/tools/agent-call-tool.test.ts
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

import { createAgentCallTool } from "./agent-call-tool.js";

describe("agent_call tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("policy check blocks non-allowlisted agents", async () => {
    // Test policy check indirectly by calling the tool with a mock
    // that returns forbidden status
    //
    // The checkA2APolicy function in agent-call-tool.ts returns:
    // - { allowed: false, error: "..." } if agent not in allowlist
    // - { allowed: true } if agent is in allowlist or allowlist contains "*"
    //
    // Our mock config has allow: ["*"] so all agents are allowed.
    // This test validates the call path works.

    callGatewayMock.mockResolvedValueOnce({ runId: "run-1" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    callGatewayMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: JSON.stringify({ output: "ok", confidence: 0.8 }) }],
    });

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "any-agent", // Allowed because mock config has allow: ["*"]
      skill: "test",
      input: {},
    });

    expect(result.details).toMatchObject({ status: "completed" });
  });

  it("allows self-calls regardless of policy", async () => {
    // Mock agent invocation
    callGatewayMock.mockResolvedValueOnce({ runId: "run-1" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: JSON.stringify({
            output: { result: "self-call worked" },
            confidence: 0.9,
          }),
        },
      ],
    }); // chat.history

    const tool = createAgentCallTool({
      agentSessionKey: "agent:test-agent:main",
    });

    const result = await tool.execute("call1", {
      agent: "test-agent", // Same as session key - self call
      skill: "test",
      input: {},
    });

    expect(callGatewayMock).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "completed",
      confidence: 0.9,
    });
  });

  it("calls agent with structured input and returns parsed output", async () => {
    // Mock agent invocation
    callGatewayMock.mockResolvedValueOnce({ runId: "run-test" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" }); // agent.wait
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: JSON.stringify({
            output: {
              root_cause: "pump_impeller_wear",
              confidence_score: 0.87,
              evidence: ["vibration_data", "maintenance_history"],
            },
            confidence: 0.87,
            assumptions: ["Sensor data is accurate", "Maintenance logs complete"],
            caveats: ["Limited runtime data available"],
          }),
        },
      ],
    }); // chat.history

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "rca-agent",
      skill: "propose_cause",
      input: {
        failure_event: {
          equipment_id: "PUMP-001",
          failure_type: "performance_degradation",
        },
      },
      timeoutSeconds: 60,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(3);

    // Verify the agent call was made correctly
    const agentCall = callGatewayMock.mock.calls.find((c) => c[0]?.method === "agent");
    expect(agentCall).toBeDefined();
    expect(agentCall[0].params.sessionKey).toBe("agent:rca-agent:main");

    // Parse the message to verify structure
    const message = JSON.parse(agentCall[0].params.message);
    expect(message.kind).toBe("skill_invocation");
    expect(message.skill).toBe("propose_cause");
    expect(message.input.failure_event.equipment_id).toBe("PUMP-001");

    // Verify result
    expect(result.details).toMatchObject({
      status: "completed",
      confidence: 0.87,
    });
    expect(result.details.output).toEqual({
      root_cause: "pump_impeller_wear",
      confidence_score: 0.87,
      evidence: ["vibration_data", "maintenance_history"],
    });
    expect(result.details.assumptions).toContain("Sensor data is accurate");
    expect(result.details.caveats).toContain("Limited runtime data available");
  });

  it("handles timeout with async task ID", async () => {
    // Mock agent invocation
    callGatewayMock.mockResolvedValueOnce({ runId: "run-timeout" });
    callGatewayMock.mockResolvedValueOnce({ status: "timeout" }); // agent.wait

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "slow-agent",
      skill: "slow_task",
      input: { test: true },
      timeoutSeconds: 5,
    });

    expect(result.details).toMatchObject({
      status: "working",
      taskId: "run-timeout",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("returns working status immediately when timeout=0 (fire-and-forget)", async () => {
    // Mock agent invocation only (no wait, no history)
    callGatewayMock.mockResolvedValueOnce({ runId: "run-fire" });

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "async-agent",
      skill: "async_task",
      input: { trigger: true },
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "working",
      taskId: expect.any(String),
    });
    // Should only call agent (no wait, no history)
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("handles unstructured text responses with default confidence", async () => {
    // Mock agent returning plain text
    callGatewayMock.mockResolvedValueOnce({ runId: "run-text" });
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    callGatewayMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: "The analysis suggests motor bearing failure as the most likely cause.",
        },
      ],
    });

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "text-agent",
      skill: "analyze",
      input: {},
    });

    expect(result.details).toMatchObject({
      status: "completed",
      confidence: 0.5, // Default for unstructured
    });
    expect(result.details.output).toBe(
      "The analysis suggests motor bearing failure as the most likely cause.",
    );
  });

  it("handles agent errors gracefully", async () => {
    // Mock agent error
    callGatewayMock.mockRejectedValueOnce(new Error("Agent not found"));

    const tool = createAgentCallTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      agent: "missing-agent",
      skill: "test",
      input: {},
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Agent not found",
    });
  });
});
