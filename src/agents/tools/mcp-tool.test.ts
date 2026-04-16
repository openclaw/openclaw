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
      listResources: vi.fn(),
      readResource: vi.fn(),
      getServerAuthState: vi.fn(),
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
      listResources: vi.fn(),
      readResource: vi.fn(),
      getServerAuthState: vi.fn(),
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

  it("lists MCP resources via runtime listResources", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(),
      listResources: vi.fn(async () => [{ serverName: "bundleProbe", uri: "mem://a", name: "a" }]),
      readResource: vi.fn(),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createMcpTool } = await import("./mcp-tool.js");
    const tool = createMcpTool({
      sessionId: "session-3",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-3", { action: "list_resources", server: "bundleProbe" });

    expect(runtime.listResources).toHaveBeenCalledWith("bundleProbe");
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "list_resources",
        count: 1,
      },
    });
  });

  it("reads MCP resources via runtime readResource", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(async () => ({ contents: [{ uri: "mem://a", text: "hello" }] })),
      getServerAuthState: vi.fn(),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createMcpTool } = await import("./mcp-tool.js");
    const tool = createMcpTool({
      sessionId: "session-4",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-4", {
      action: "read_resource",
      server: "bundleProbe",
      uri: "mem://a",
    });

    expect(runtime.readResource).toHaveBeenCalledWith("bundleProbe", "mem://a");
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "read_resource",
        server: "bundleProbe",
        uri: "mem://a",
      },
    });
  });

  it("reports MCP auth state via runtime getServerAuthState", async () => {
    const runtime = {
      getCatalog: vi.fn(),
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      getServerAuthState: vi.fn(async () => ({
        server: "bundleProbe",
        status: "connected",
        toolCount: 2,
        resourceCount: 1,
      })),
    };
    mcpRuntimeMock.getOrCreateSessionMcpRuntime.mockResolvedValueOnce(runtime);

    const { createMcpTool } = await import("./mcp-tool.js");
    const tool = createMcpTool({
      sessionId: "session-5",
      workspaceDir: "/tmp/workspace",
    });
    const result = await tool.execute("tool-5", {
      action: "auth",
      server: "bundleProbe",
    });

    expect(runtime.getServerAuthState).toHaveBeenCalledWith("bundleProbe");
    expect(result).toMatchObject({
      details: {
        status: "ok",
        action: "auth",
        server: "bundleProbe",
        toolCount: 2,
        resourceCount: 1,
      },
    });
  });
});
