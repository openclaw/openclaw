import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestOrchestratorTool } from "./request-orchestrator-tool.js";

const {
  mockCallGateway,
  mockEmitAgentEvent,
  mockGetRunByChildKey,
  mockIsSubagentSessionKey,
  mockCreateRequest,
  mockWaitForResolution,
  mockGetRequest,
} = vi.hoisted(() => ({
  mockCallGateway: vi.fn(async () => ({ sessions: [] })),
  mockEmitAgentEvent: vi.fn(),
  mockGetRunByChildKey: vi.fn(),
  mockIsSubagentSessionKey: vi.fn(() => false),
  mockCreateRequest: vi.fn(() => "req_test-123"),
  mockWaitForResolution: vi.fn(async () => ({
    requestId: "req_test-123",
    status: "resolved" as const,
    response: "guidance text",
    resolvedAt: Date.now(),
    childSessionKey: "agent:main:subagent:child-1",
    parentSessionKey: "agent:main:main",
    message: "help",
    priority: "normal" as const,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
  })),
  mockGetRequest: vi.fn(() => ({
    requestId: "req_test-123",
    timeoutAt: Date.now() + 300_000,
  })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mockCallGateway,
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: mockEmitAgentEvent,
}));

vi.mock("../../routing/session-key.js", () => ({
  isSubagentSessionKey: mockIsSubagentSessionKey,
}));

vi.mock("../subagent-registry.js", () => ({
  getRunByChildKey: mockGetRunByChildKey,
}));

vi.mock("../orchestrator-request-registry.js", () => ({
  createOrchestratorRequest: mockCreateRequest,
  waitForResolution: mockWaitForResolution,
  getOrchestratorRequest: mockGetRequest,
}));

vi.mock("../lanes.js", () => ({
  AGENT_LANE_NESTED: "nested",
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "__internal__",
}));

describe("request_orchestrator tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallGateway.mockResolvedValue({
      key: "agent:main:main",
    });
    mockGetRunByChildKey.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      label: "test-task",
      runId: "run-1",
    });
    mockIsSubagentSessionKey.mockReturnValue(true);
    mockCreateRequest.mockReturnValue("req_test-123");
    mockGetRequest.mockReturnValue({
      requestId: "req_test-123",
      timeoutAt: Date.now() + 300_000,
    });
    mockWaitForResolution.mockResolvedValue({
      requestId: "req_test-123",
      status: "resolved",
      response: "guidance text",
      resolvedAt: Date.now(),
      childSessionKey: "agent:main:subagent:child-1",
      parentSessionKey: "agent:main:main",
      message: "help",
      priority: "normal",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
    });
  });

  it("rejects from non-subagent session", async () => {
    mockIsSubagentSessionKey.mockReturnValue(false);
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("error");
    expect(payload.error).toMatch(/subagent/i);
  });

  it("resolves parent from registry", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runId: "run-1",
    });
    await tool.execute("tc-1", { message: "help" });
    expect(mockGetRunByChildKey).toHaveBeenCalledWith("agent:main:subagent:child-1");
  });

  it("fails fast when parent unavailable", async () => {
    mockCallGateway.mockResolvedValue({});
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("parent_unavailable");
  });

  it("creates request and blocks until resolved", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runId: "run-1",
    });
    const result = await tool.execute("tc-1", { message: "help me" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("resolved");
    expect(payload.response).toBe("guidance text");
    expect(mockCreateRequest).toHaveBeenCalled();
    expect(mockWaitForResolution).toHaveBeenCalled();
  });

  it("returns timeout error when no response", async () => {
    mockWaitForResolution.mockResolvedValue({
      requestId: "req_test-123",
      status: "timeout",
      error: "Parent did not respond",
      childSessionKey: "agent:main:subagent:child-1",
      parentSessionKey: "agent:main:main",
      message: "help",
      priority: "normal",
      createdAt: Date.now(),
      timeoutAt: Date.now(),
    });
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("timeout");
    expect(payload.error).toBeDefined();
  });

  it("caps timeout to remaining run time", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runTimeoutMs: 60_000,
      runStartedAt: Date.now() - 50_000, // 50s elapsed, 10s remaining
    });
    // 10s remaining - 30s buffer = negative → should fail fast
    const result = await tool.execute("tc-1", { message: "help", timeoutSeconds: 300 });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("timeout");
    expect(payload.error).toMatch(/insufficient/i);
  });

  it("fails immediately when insufficient remaining time", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runTimeoutMs: 60_000,
      runStartedAt: Date.now() - 55_000,
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("timeout");
    expect(payload.error).toMatch(/insufficient/i);
  });

  it("injects notification to parent session", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runId: "run-1",
    });
    await tool.execute("tc-1", { message: "help me please" });
    // callGateway should be called at least twice: once for session list, once for notification
    const agentCalls = mockCallGateway.mock.calls.filter(
      (call) => (call[0] as { method: string }).method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const agentCall = agentCalls[0][0] as { params: { message: string; sessionKey: string } };
    expect(agentCall.params.message).toContain("subagent_request");
    expect(agentCall.params.message).toContain("help me please");
    expect(agentCall.params.sessionKey).toBe("agent:main:main");
  });

  it("emits orchestrator_request agent event", async () => {
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
      runId: "run-1",
    });
    await tool.execute("tc-1", { message: "help" });
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "orchestrator_request",
        data: expect.objectContaining({
          requestId: "req_test-123",
          childSessionKey: "agent:main:subagent:child-1",
          parentSessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("respects abort signal on child kill", async () => {
    mockWaitForResolution.mockRejectedValue(new Error("Aborted"));
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("cancelled");
  });

  it("uses runtime abort signal from execute context", async () => {
    const controller = new AbortController();
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    await tool.execute("tc-1", { message: "help" }, controller.signal);
    expect(mockWaitForResolution).toHaveBeenCalledWith(
      "req_test-123",
      expect.any(Number),
      controller.signal,
    );
  });

  it("enforces max pending per child cap", async () => {
    mockCreateRequest.mockImplementation(() => {
      throw new Error("Max pending requests (3) reached for child");
    });
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("error");
    expect(payload.error).toMatch(/pending requests/i);
  });

  it("handles missing run record", async () => {
    mockGetRunByChildKey.mockReturnValue(undefined);
    const tool = createRequestOrchestratorTool({
      agentSessionKey: "agent:main:subagent:child-1",
    });
    const result = await tool.execute("tc-1", { message: "help" });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const payload = JSON.parse(text);
    expect(payload.status).toBe("error");
    expect(payload.error).toMatch(/parent/i);
  });
});
