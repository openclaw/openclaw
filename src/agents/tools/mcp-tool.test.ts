import { describe, expect, it, vi } from "vitest";

const mcpRuntimeMock = vi.hoisted(() => ({
  getOrCreateSessionMcpRuntime: vi.fn(),
}));

vi.mock("../pi-bundle-mcp-runtime.js", () => ({
  getOrCreateSessionMcpRuntime: mcpRuntimeMock.getOrCreateSessionMcpRuntime,
}));

describe("createMcpTool", () => {
  it("returns catalog from the session runtime", async () => {
    const runtime = {
      getCatalog: vi.fn(async () => ({ version: 1, generatedAt: 1, servers: {}, tools: [] })),
      callTool: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createMcpTool } = await import("./mcp-tool.js");
    const tool = createMcpTool({
      sessionId: "session-1",
      agentSessionKey: "agent:main",
      workspaceDir: "/tmp/workspace",
    });

    const result = await tool.execute("tool-1", { action: "catalog" });

    expect(mcpRuntimeMock.getOrCreateSessionMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(runtime.getCatalog).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "catalog",
      },
    });
  });

  it("calls bundle MCP tools from qualified name and input", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createMcpTool } = await import("./mcp-tool.js");
    const tool = createMcpTool({
      sessionId: "session-2",
      workspaceDir: "/tmp/workspace",
    });

    const result = await tool.execute("tool-2", {
      name: "bundleProbe__bundle_probe",
      input: { text: "hi" },
    });

    expect(runtime.callTool).toHaveBeenCalledWith("bundleProbe", "bundle_probe", { text: "hi" });
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "call",
        serverName: "bundleProbe",
        toolName: "bundle_probe",
      },
    });
  });
});

