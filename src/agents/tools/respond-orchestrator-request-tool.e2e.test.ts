import { describe, expect, it, vi } from "vitest";
import { createRespondOrchestratorRequestTool } from "./respond-orchestrator-request-tool.js";

const { mockGetRequest, mockResolveRequest } = vi.hoisted(() => ({
  mockGetRequest: vi.fn(),
  mockResolveRequest: vi.fn(),
}));

vi.mock("../orchestrator-request-registry.js", () => ({
  getOrchestratorRequest: mockGetRequest,
  resolveOrchestratorRequest: mockResolveRequest,
}));

function parseResult(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("respond_orchestrator_request tool", () => {
  it("resolves pending request successfully", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "pending",
      parentSessionKey: "agent:main:main",
    });
    mockResolveRequest.mockImplementation(() => {});

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "Use the SEC number",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("ok");
    expect(mockResolveRequest).toHaveBeenCalledWith(
      "req_abc123",
      "Use the SEC number",
      "agent:main:main",
    );
  });

  it("rejects when requestId not found", async () => {
    mockGetRequest.mockReturnValue(undefined);

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_nonexistent",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("not_found");
  });

  it("rejects when request already resolved", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "resolved",
      parentSessionKey: "agent:main:main",
    });

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("already_resolved");
  });

  it("rejects when caller is not authorized parent", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "pending",
      parentSessionKey: "agent:main:main",
    });

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:subagent:other-child",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("forbidden");
  });

  it("rejects when request expired", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "timeout",
      parentSessionKey: "agent:main:main",
    });

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("expired");
  });

  it("wakes blocked child tool call", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "notified",
      parentSessionKey: "agent:main:main",
    });
    mockResolveRequest.mockImplementation(() => {});

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "do X",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("ok");
    expect(mockResolveRequest).toHaveBeenCalledWith("req_abc123", "do X", "agent:main:main");
  });

  it("handles resolve errors gracefully", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "pending",
      parentSessionKey: "agent:main:main",
    });
    mockResolveRequest.mockImplementation(() => {
      throw new Error("Request has expired");
    });

    const tool = createRespondOrchestratorRequestTool({
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("expired");
    expect(payload.error).toMatch(/expired/i);
  });

  it("rejects when caller session key is missing", async () => {
    mockGetRequest.mockReturnValue({
      requestId: "req_abc123",
      status: "pending",
      parentSessionKey: "agent:main:main",
    });

    const tool = createRespondOrchestratorRequestTool();
    const result = await tool.execute("tc-1", {
      requestId: "req_abc123",
      response: "answer",
    });
    const payload = parseResult(result);
    expect(payload.status).toBe("forbidden");
  });
});
