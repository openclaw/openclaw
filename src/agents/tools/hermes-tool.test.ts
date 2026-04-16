import { describe, expect, it, vi } from "vitest";

const mcpRuntimeMock = vi.hoisted(() => ({
  getOrCreateSessionMcpRuntime: vi.fn(),
}));

vi.mock("../pi-bundle-mcp-runtime.js", () => ({
  getOrCreateSessionMcpRuntime: mcpRuntimeMock.getOrCreateSessionMcpRuntime,
}));

describe("createHermesTool", () => {
  it("routes memory_reflect to default Hermes tool", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-1",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-1", {
      action: "memory_reflect",
      prompt: "Summarize the last session",
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes", "memory_reflect", {
      prompt: "Summarize the last session",
    });
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "memory_reflect",
        server: "hermes",
        toolName: "memory_reflect",
      },
    });
  });

  it("uses custom route tool names and server from config", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-2",
      workspaceDir: "/tmp/workspace",
      config: { mcp: { servers: { "hermes-main": { command: "python3" } } } } as never,
      routeToolNames: { long_plan: "plan_decompose" },
    });
    await tool.execute("tool-2", {
      action: "long_plan",
      goal: "Ship parity integration",
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes-main", "plan_decompose", {
      prompt: "Ship parity integration",
    });
  });

  it("infers long_plan when action is omitted but planning intent is explicit", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-2b",
      workspaceDir: "/tmp/workspace",
    });
    await tool.execute("tool-2b", {
      prompt: "Please create a multi-phase roadmap with milestones for this migration",
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes", "long_plan", {
      prompt: "Please create a multi-phase roadmap with milestones for this migration",
    });
  });

  it("supports explicit call passthrough", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-3",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-3", {
      action: "call",
      server: "hermes-main",
      tool: "messages_read",
      input: { session_key: "telegram:abc", limit: 5 },
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes-main", "messages_read", {
      session_key: "telegram:abc",
      limit: 5,
    });
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "call",
        server: "hermes-main",
        toolName: "messages_read",
      },
    });
  });

  it("routes messages_read with session_key shim", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-3b",
      workspaceDir: "/tmp/workspace",
    });
    await tool.execute("tool-3b", {
      action: "messages_read",
      sessionKey: "telegram:123",
      limit: 20,
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes", "messages_read", {
      session_key: "telegram:123",
      limit: 20,
    });
  });

  it("routes messages_send with required fields", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-3c",
      workspaceDir: "/tmp/workspace",
    });
    await tool.execute("tool-3c", {
      action: "messages_send",
      target: "telegram:123",
      message: "hello",
    });

    expect(runtime.callTool).toHaveBeenCalledWith("hermes", "messages_send", {
      target: "telegram:123",
      message: "hello",
      prompt: "hello",
    });
  });

  it("rejects missing required fields for hermes mapped actions", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-3d",
      workspaceDir: "/tmp/workspace",
    });

    await expect(
      tool.execute("tool-3d", {
        action: "attachments_fetch",
        session_key: "telegram:123",
      }),
    ).rejects.toThrow("session_key and message_id required");
  });

  it("returns status from MCP auth state", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(),
      getServerAuthState: vi.fn(async () => ({
        server: "hermes",
        status: "connected",
        toolCount: 3,
        resourceCount: 1,
      })),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createHermesTool } = await import("./hermes-tool.js");
    const tool = createHermesTool({
      sessionId: "session-hermes-4",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-4", { action: "status" });

    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "status",
        server: "hermes",
        connectionStatus: "connected",
      },
    });
  });
});
