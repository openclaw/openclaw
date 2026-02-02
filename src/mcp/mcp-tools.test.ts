import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig, McpServersConfig } from "../config/types.mcp.js";
import { resolveMcpToolsForAgent, shutdownAllMcpServers, __testing } from "./mcp-tools.js";

const {
  mcpPiToolName,
  normalizeToolComponent,
  stringifyToolResultContent,
  stableStringify,
  stableHash,
  buildMcpPiTool,
  McpConnection,
  agentStates,
  ensureAgentState,
  getOrCreateConnection,
} = __testing;

// ---------------------------------------------------------------------------
// Mock the MCP SDK transports and client
// ---------------------------------------------------------------------------

const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

// Use class-based mocks for constructors (required for `new` syntax)
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any) {
    this.connect = mockConnect;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = mockClose;
  }),
  getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = mockClose;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = mockClose;
  }),
}));

// ---------------------------------------------------------------------------
// Tool name generation
// ---------------------------------------------------------------------------

describe("mcpPiToolName", () => {
  it("generates correct tool name format", () => {
    expect(mcpPiToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  it("normalizes server ID to lowercase", () => {
    expect(mcpPiToolName("GitHub", "create_issue")).toBe("mcp__github__create_issue");
  });

  it("replaces special characters with underscores", () => {
    expect(mcpPiToolName("my-server", "my.tool")).toBe("mcp__my-server__my_tool");
  });

  it("handles empty server ID with fallback", () => {
    expect(mcpPiToolName("", "my_tool")).toBe("mcp__server__my_tool");
  });

  it("handles empty tool name with fallback", () => {
    expect(mcpPiToolName("myserver", "")).toBe("mcp__myserver__tool");
  });

  it("handles whitespace-only inputs", () => {
    expect(mcpPiToolName("  ", "  ")).toBe("mcp__server__tool");
  });

  it("preserves hyphens in names", () => {
    expect(mcpPiToolName("my-mcp-server", "do-something")).toBe("mcp__my-mcp-server__do-something");
  });
});

describe("normalizeToolComponent", () => {
  it("converts to lowercase", () => {
    expect(normalizeToolComponent("GitHub")).toBe("github");
  });

  it("trims whitespace", () => {
    expect(normalizeToolComponent("  server  ")).toBe("server");
  });

  it("replaces non-alphanumeric characters except underscore and hyphen", () => {
    expect(normalizeToolComponent("my.server@test")).toBe("my_server_test");
  });

  it("removes leading/trailing underscores", () => {
    expect(normalizeToolComponent("__test__")).toBe("test");
  });

  it("handles consecutive special characters", () => {
    expect(normalizeToolComponent("a...b")).toBe("a_b");
  });
});

// ---------------------------------------------------------------------------
// Stable hashing
// ---------------------------------------------------------------------------

describe("stableStringify", () => {
  it("handles null", () => {
    expect(stableStringify(null)).toBe("null");
  });

  it("handles undefined", () => {
    expect(stableStringify(undefined)).toBe("undefined");
  });

  it("handles strings", () => {
    expect(stableStringify("hello")).toBe('"hello"');
  });

  it("handles numbers", () => {
    expect(stableStringify(42)).toBe("42");
  });

  it("handles booleans", () => {
    expect(stableStringify(true)).toBe("true");
  });

  it("handles arrays", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("sorts object keys for stability", () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(stableStringify(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with stable key ordering", () => {
    const obj = { b: { y: 1, x: 2 }, a: 3 };
    expect(stableStringify(obj)).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });
});

describe("stableHash", () => {
  it("produces consistent hash for same input", () => {
    const hash1 = stableHash({ a: 1, b: 2 });
    const hash2 = stableHash({ b: 2, a: 1 });
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = stableHash({ a: 1 });
    const hash2 = stableHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });

  it("produces 64-char hex string (SHA-256)", () => {
    const hash = stableHash("test");
    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool result content stringification
// ---------------------------------------------------------------------------

describe("stringifyToolResultContent", () => {
  it("handles text content", () => {
    const result = stringifyToolResultContent({ type: "text", text: "Hello world" });
    expect(result).toEqual({ type: "text", text: "Hello world" });
  });

  it("handles text content with missing text field", () => {
    const result = stringifyToolResultContent({ type: "text" });
    expect(result).toEqual({ type: "text", text: "" });
  });

  it("handles image content", () => {
    const result = stringifyToolResultContent({
      type: "image",
      data: "base64data",
      mimeType: "image/jpeg",
    });
    expect(result).toEqual({ type: "image", data: "base64data", mimeType: "image/jpeg" });
  });

  it("uses default mimeType for images", () => {
    const result = stringifyToolResultContent({ type: "image", data: "data" });
    expect(result).toEqual({ type: "image", data: "data", mimeType: "image/png" });
  });

  it("converts audio content to text placeholder", () => {
    const result = stringifyToolResultContent({
      type: "audio",
      data: "audiodata123",
      mimeType: "audio/wav",
    });
    expect(result).toEqual({
      type: "text",
      text: "[MCP audio content: audio/wav (12 base64 chars)]",
    });
  });

  it("converts resource with text to text content", () => {
    const result = stringifyToolResultContent({
      type: "resource",
      resource: { uri: "file:///test.txt", text: "file contents here" },
    });
    expect(result).toEqual({ type: "text", text: "file contents here" });
  });

  it("converts resource with blob to placeholder", () => {
    const result = stringifyToolResultContent({
      type: "resource",
      resource: { uri: "file:///test.bin", blob: "binarydata123456" },
    });
    expect(result).toEqual({
      type: "text",
      text: "[MCP resource blob: file:///test.bin (16 base64 chars)]",
    });
  });

  it("converts resource without text/blob to URI", () => {
    const result = stringifyToolResultContent({
      type: "resource",
      resource: { uri: "file:///test.txt" },
    });
    expect(result).toEqual({ type: "text", text: "file:///test.txt" });
  });

  it("handles unknown content types as JSON", () => {
    const result = stringifyToolResultContent({ type: "custom", data: { foo: "bar" } });
    expect(result.type).toBe("text");
    expect((result as any).text).toContain('"type": "custom"');
    expect((result as any).text).toContain('"foo": "bar"');
  });

  it("handles missing type as unknown", () => {
    const result = stringifyToolResultContent({ data: "something" });
    expect(result.type).toBe("text");
    expect((result as any).text).toContain('"data": "something"');
  });
});

// ---------------------------------------------------------------------------
// Tool construction
// ---------------------------------------------------------------------------

describe("buildMcpPiTool", () => {
  const mockConnection = {
    callTool: vi.fn(),
  } as any;

  const baseTool = {
    name: "create_issue",
    description: "Creates a new issue",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates tool with correct name format", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: baseTool,
      connection: mockConnection,
    });
    expect(tool.name).toBe("mcp__github__create_issue");
  });

  it("creates tool with correct label using server ID", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: baseTool,
      connection: mockConnection,
    });
    expect(tool.label).toBe("mcp:github:create_issue");
  });

  it("creates tool with custom server label", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      serverLabel: "GitHub API",
      tool: baseTool,
      connection: mockConnection,
    });
    expect(tool.label).toBe("mcp:GitHub API:create_issue");
  });

  it("uses tool description from MCP server", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: baseTool,
      connection: mockConnection,
    });
    expect(tool.description).toBe("Creates a new issue");
  });

  it("provides fallback description when missing", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: { ...baseTool, description: undefined },
      connection: mockConnection,
    });
    expect(tool.description).toBe("MCP tool: create_issue");
  });

  it("passes through input schema as parameters", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: baseTool,
      connection: mockConnection,
    });
    expect(tool.parameters).toEqual(baseTool.inputSchema);
  });

  it("provides default schema when inputSchema is missing", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      tool: { name: "simple_tool" } as any,
      connection: mockConnection,
    });
    expect(tool.parameters).toEqual({ type: "object" });
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe("MCP tool execution", () => {
  const mockConnection = {
    callTool: vi.fn(),
  } as any;

  const baseTool = {
    name: "test_tool",
    description: "Test tool",
    inputSchema: { type: "object" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes tool and returns content", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "Result text" }],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    const result = await tool.execute("call-1", { input: "value" }, undefined);

    expect(mockConnection.callTool).toHaveBeenCalledWith({
      toolName: "test_tool",
      args: { input: "value" },
      signal: undefined,
    });
    expect(result.content).toEqual([{ type: "text", text: "Result text" }]);
  });

  it("includes details in result", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "Done" }],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "myserver",
      tool: baseTool,
      connection: mockConnection,
    });

    const result = await tool.execute("call-123", {}, undefined);

    expect(result.details).toMatchObject({
      toolCallId: "call-123",
      serverId: "myserver",
      tool: "test_tool",
    });
  });

  it("throws error when isError is true", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "Something went wrong" }],
      isError: true,
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    await expect(tool.execute("call-1", {}, undefined)).rejects.toThrow("Something went wrong");
  });

  it("provides fallback error message when isError with empty content", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [],
      isError: true,
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    await expect(tool.execute("call-1", {}, undefined)).rejects.toThrow(
      "MCP tool failed: test/test_tool",
    );
  });

  it("handles multiple text content blocks in error", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [
        { type: "text", text: "Error line 1" },
        { type: "text", text: "Error line 2" },
      ],
      isError: true,
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    await expect(tool.execute("call-1", {}, undefined)).rejects.toThrow(
      "Error line 1\nError line 2",
    );
  });

  it("handles null/undefined params gracefully", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    await tool.execute("call-1", null as any, undefined);

    expect(mockConnection.callTool).toHaveBeenCalledWith({
      toolName: "test_tool",
      args: {},
      signal: undefined,
    });
  });

  it("passes abort signal to callTool", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    const controller = new AbortController();
    await tool.execute("call-1", {}, controller.signal);

    expect(mockConnection.callTool).toHaveBeenCalledWith({
      toolName: "test_tool",
      args: {},
      signal: controller.signal,
    });
  });
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe("ensureAgentState", () => {
  beforeEach(() => {
    agentStates.clear();
  });

  it("creates new state for unknown agent", () => {
    const servers: McpServersConfig = {
      test: { command: "echo", args: ["hello"] },
    };
    const state = ensureAgentState("agent1", servers);
    expect(state.servers).toBe(servers);
    expect(state.connections.size).toBe(0);
    expect(state.toolsPromise).toBeNull();
  });

  it("normalizes agent ID to lowercase", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    ensureAgentState("AGENT1", servers);
    expect(agentStates.has("agent1")).toBe(true);
  });

  it("uses 'main' for empty agent ID", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    ensureAgentState("", servers);
    expect(agentStates.has("main")).toBe(true);
  });

  it("returns existing state if config hash matches", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    const state1 = ensureAgentState("agent1", servers);
    const state2 = ensureAgentState("agent1", servers);
    expect(state1).toBe(state2);
  });

  it("replaces state when config changes", () => {
    const servers1: McpServersConfig = {
      test: { command: "echo" },
    };
    const servers2: McpServersConfig = {
      test: { command: "different" },
    };
    const state1 = ensureAgentState("agent1", servers1);
    const state2 = ensureAgentState("agent1", servers2);
    expect(state1).not.toBe(state2);
    expect(state2.servers).toBe(servers2);
  });
});

describe("getOrCreateConnection", () => {
  beforeEach(() => {
    agentStates.clear();
  });

  it("creates new connection for unknown server", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    const state = ensureAgentState("agent1", servers);
    const conn = getOrCreateConnection(state, "test");
    expect(conn).toBeInstanceOf(McpConnection);
    expect(conn.serverId).toBe("test");
  });

  it("returns existing connection for known server", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    const state = ensureAgentState("agent1", servers);
    const conn1 = getOrCreateConnection(state, "test");
    const conn2 = getOrCreateConnection(state, "test");
    expect(conn1).toBe(conn2);
  });

  it("throws for unknown server ID", () => {
    const servers: McpServersConfig = {
      test: { command: "echo" },
    };
    const state = ensureAgentState("agent1", servers);
    expect(() => getOrCreateConnection(state, "unknown")).toThrow("Unknown MCP server: unknown");
  });
});

// ---------------------------------------------------------------------------
// resolveMcpToolsForAgent integration
// ---------------------------------------------------------------------------

describe("resolveMcpToolsForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStates.clear();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "tool1",
          description: "First tool",
          inputSchema: { type: "object" },
        },
        {
          name: "tool2",
          description: "Second tool",
          inputSchema: { type: "object" },
        },
      ],
    });
  });

  afterEach(async () => {
    await shutdownAllMcpServers();
  });

  it("returns empty array when no MCP servers configured", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: {},
      agentId: "main",
    });
    expect(tools).toEqual([]);
  });

  it("returns empty array when all servers are disabled", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo", enabled: false },
        },
      } as any,
      agentId: "main",
    });
    expect(tools).toEqual([]);
  });

  it("loads tools from configured MCP server", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo", args: ["hello"] },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("mcp__test__tool1");
    expect(tools[1]?.name).toBe("mcp__test__tool2");
  });

  it("sorts tools alphabetically by name", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "zebra", inputSchema: {} },
        { name: "alpha", inputSchema: {} },
        { name: "beta", inputSchema: {} },
      ],
    });

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools.map((t) => t.name)).toEqual([
      "mcp__test__alpha",
      "mcp__test__beta",
      "mcp__test__zebra",
    ]);
  });

  it("caches tools promise for same config", async () => {
    const config = {
      mcpServers: {
        test: { command: "echo" },
      },
    } as any;

    const tools1 = await resolveMcpToolsForAgent({ config, agentId: "main" });
    const tools2 = await resolveMcpToolsForAgent({ config, agentId: "main" });

    expect(tools1).toBe(tools2);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it("handles server connection failure gracefully", async () => {
    mockConnect.mockRejectedValue(new Error("Connection refused"));

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          failing: { command: "nonexistent" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toEqual([]);
  });

  it("continues loading other servers when one fails", async () => {
    // Reset mock to return different results based on call order
    let callCount = 0;
    mockConnect.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("First server failed");
      }
    });
    mockListTools.mockResolvedValue({
      tools: [{ name: "working_tool", inputSchema: {} }],
    });

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          failing: { command: "bad" },
          working: { command: "good" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__working__working_tool");
  });

  it("skips tools with empty names", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "valid", inputSchema: {} },
        { name: "", inputSchema: {} },
        { name: "   ", inputSchema: {} },
        { name: null, inputSchema: {} },
      ],
    });

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__test__valid");
  });

  it("passes abort signal to listTools", async () => {
    const controller = new AbortController();

    await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "main",
      abortSignal: controller.signal,
    });

    // MCP SDK listTools signature: listTools(undefined, { signal })
    expect(mockListTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });
});

// ---------------------------------------------------------------------------
// shutdownAllMcpServers
// ---------------------------------------------------------------------------

describe("shutdownAllMcpServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStates.clear();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
  });

  it("clears all agent states", async () => {
    // Setup some state
    await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "agent1",
    });

    await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "agent2",
    });

    expect(agentStates.size).toBe(2);

    await shutdownAllMcpServers();

    expect(agentStates.size).toBe(0);
  });

  it("calls close on all connections", async () => {
    await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          server1: { command: "echo" },
          server2: { command: "echo" },
        },
      } as any,
      agentId: "main",
    });

    await shutdownAllMcpServers();

    // Each server gets a connection, close should be called on each
    expect(mockClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// McpConnection class
// ---------------------------------------------------------------------------

describe("McpConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("stores serverId and server config", () => {
    const server: McpServerConfig = { command: "echo", args: ["test"] };
    const conn = new McpConnection({ serverId: "test", server });
    expect(conn.serverId).toBe("test");
    expect(conn.server).toBe(server);
  });

  it("connect is idempotent", async () => {
    const server: McpServerConfig = { command: "echo" };
    const conn = new McpConnection({ serverId: "test", server });

    await conn.connect();
    await conn.connect();
    await conn.connect();

    // Client constructor should only be called once
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it("listTools throws if client missing after connect failure", async () => {
    mockConnect.mockRejectedValue(new Error("Connect failed"));

    const server: McpServerConfig = { command: "bad" };
    const conn = new McpConnection({ serverId: "test", server });

    await expect(conn.listTools()).rejects.toThrow();
  });

  it("callTool throws if client missing", async () => {
    mockConnect.mockRejectedValue(new Error("Connect failed"));

    const server: McpServerConfig = { command: "bad" };
    const conn = new McpConnection({ serverId: "test", server });

    await expect(conn.callTool({ toolName: "test", args: {} })).rejects.toThrow();
  });

  it("close resets connection state", async () => {
    const server: McpServerConfig = { command: "echo" };
    const conn = new McpConnection({ serverId: "test", server });

    await conn.connect();
    await conn.close();

    // After close, calling connect again should create new client
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    vi.mocked(Client).mockClear();

    await conn.connect();
    expect(Client).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

describe("MCP transport selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("uses stdio transport by default", async () => {
    const server: McpServerConfig = { command: "echo", args: ["test"] };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo",
        args: ["test"],
      }),
    );
  });

  it("uses SSE transport when specified", async () => {
    const server = {
      transport: "sse" as const,
      url: "https://example.com/mcp",
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    expect(SSEClientTransport).toHaveBeenCalled();
  });

  it("uses HTTP transport when specified", async () => {
    const server = {
      transport: "http" as const,
      url: "https://example.com/mcp",
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(StreamableHTTPClientTransport).toHaveBeenCalled();
  });

  it("merges custom env with default environment for stdio", async () => {
    const server: McpServerConfig = {
      command: "echo",
      env: { CUSTOM_VAR: "value" },
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/usr/bin",
          CUSTOM_VAR: "value",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// coerceHeaders
// ---------------------------------------------------------------------------

// coerceHeaders is not exported but we can test it indirectly via transport creation
describe("HTTP/SSE headers handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("passes headers to SSE transport", async () => {
    const server = {
      transport: "sse" as const,
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token123", "X-Custom": "value" },
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: { headers: { Authorization: "Bearer token123", "X-Custom": "value" } },
        eventSourceInit: { headers: { Authorization: "Bearer token123", "X-Custom": "value" } },
      }),
    );
  });

  it("passes headers to HTTP transport", async () => {
    const server = {
      transport: "http" as const,
      url: "https://example.com/mcp",
      headers: { "X-API-Key": "secret" },
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: { headers: { "X-API-Key": "secret" } },
      }),
    );
  });

  it("handles SSE transport without headers", async () => {
    const server = {
      transport: "sse" as const,
      url: "https://example.com/mcp",
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: undefined,
        eventSourceInit: undefined,
      }),
    );
  });

  it("handles HTTP transport without headers", async () => {
    const server = {
      transport: "http" as const,
      url: "https://example.com/mcp",
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: undefined,
      }),
    );
  });

  it("filters out non-string header values", async () => {
    const server = {
      transport: "http" as const,
      url: "https://example.com/mcp",
      headers: {
        ValidHeader: "valid",
        InvalidNumber: 123 as any,
        InvalidNull: null as any,
        AnotherValid: "also-valid",
      },
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: { headers: { ValidHeader: "valid", AnotherValid: "also-valid" } },
      }),
    );
  });

  it("handles empty headers object", async () => {
    const server = {
      transport: "http" as const,
      url: "https://example.com/mcp",
      headers: {},
    };
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestInit: undefined,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Config change detection and connection lifecycle
// ---------------------------------------------------------------------------

describe("config change detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStates.clear();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
  });

  afterEach(async () => {
    await shutdownAllMcpServers();
  });

  it("closes old connections when config changes", async () => {
    const config1 = {
      mcpServers: {
        test: { command: "echo", args: ["v1"] },
      },
    } as any;

    // Load first config
    await resolveMcpToolsForAgent({ config: config1, agentId: "main" });
    expect(agentStates.get("main")?.connections.size).toBe(1);

    const config2 = {
      mcpServers: {
        test: { command: "echo", args: ["v2"] },
      },
    } as any;

    // Load second config - should close old connections
    await resolveMcpToolsForAgent({ config: config2, agentId: "main" });

    // Close should have been called on the old transport
    expect(mockClose).toHaveBeenCalled();
  });

  it("reuses state when config is identical", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "tool1", inputSchema: {} }],
    });

    const config = {
      mcpServers: {
        test: { command: "echo", args: ["test"] },
      },
    } as any;

    const tools1 = await resolveMcpToolsForAgent({ config, agentId: "main" });
    const state1 = agentStates.get("main");

    const tools2 = await resolveMcpToolsForAgent({ config, agentId: "main" });
    const state2 = agentStates.get("main");

    // Same state object should be reused
    expect(state1).toBe(state2);
    // Same tools array should be returned (cached promise)
    expect(tools1).toBe(tools2);
    // listTools should only be called once
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it("detects config change even with different key order", async () => {
    const config1 = {
      mcpServers: {
        a: { command: "echo" },
        b: { command: "echo" },
      },
    } as any;

    const config2 = {
      mcpServers: {
        b: { command: "echo" },
        a: { command: "echo" },
      },
    } as any;

    await resolveMcpToolsForAgent({ config: config1, agentId: "main" });
    const state1 = agentStates.get("main");

    await resolveMcpToolsForAgent({ config: config2, agentId: "main" });
    const state2 = agentStates.get("main");

    // Stable hashing should treat these as identical
    expect(state1).toBe(state2);
  });
});

// ---------------------------------------------------------------------------
// McpConnection lifecycle tests
// ---------------------------------------------------------------------------

describe("McpConnection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [] });
  });

  it("supports multiple connect/close cycles", async () => {
    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });

    // First cycle
    await conn.connect();
    await conn.close();

    // Second cycle
    await conn.connect();
    await conn.close();

    // Third cycle
    await conn.connect();
    const tools = await conn.listTools();
    expect(tools).toEqual([]);
    await conn.close();

    // Client should be created 3 times
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    expect(Client).toHaveBeenCalledTimes(3);
  });

  it("handles close when never connected", async () => {
    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });

    // Close without ever connecting should not throw
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("handles multiple close calls gracefully", async () => {
    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });

    await conn.connect();
    await conn.close();
    await conn.close();
    await conn.close();

    // Should not throw
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("concurrent listTools calls share connection", async () => {
    mockListTools.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { tools: [{ name: "t1", inputSchema: {} }] };
    });

    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });

    // Start multiple listTools concurrently
    const [r1, r2, r3] = await Promise.all([conn.listTools(), conn.listTools(), conn.listTools()]);

    // All should succeed
    expect(r1).toEqual([{ name: "t1", inputSchema: {} }]);
    expect(r2).toEqual([{ name: "t1", inputSchema: {} }]);
    expect(r3).toEqual([{ name: "t1", inputSchema: {} }]);

    // Client should only be created once
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it("concurrent callTool calls work correctly", async () => {
    let callCount = 0;
    mockCallTool.mockImplementation(async (params: any) => {
      callCount++;
      return { content: [{ type: "text", text: `Result ${params.name}` }] };
    });

    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });

    const calls = await Promise.all([
      conn.callTool({ toolName: "t1", args: {} }),
      conn.callTool({ toolName: "t2", args: {} }),
      conn.callTool({ toolName: "t3", args: {} }),
    ]);

    expect(callCount).toBe(3);
    expect(calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// resolveMcpToolsForAgent edge cases
// ---------------------------------------------------------------------------

describe("resolveMcpToolsForAgent edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStates.clear();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [{ name: "tool1", inputSchema: {} }],
    });
  });

  afterEach(async () => {
    await shutdownAllMcpServers();
  });

  it("handles mixed enabled/disabled servers", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          enabled1: { command: "echo", enabled: true },
          disabled1: { command: "echo", enabled: false },
          enabled2: { command: "echo" }, // enabled by default
          disabled2: { command: "echo", enabled: false },
        },
      } as any,
      agentId: "main",
    });

    // Only enabled servers should have tools loaded
    expect(tools.map((t) => t.name)).toEqual(["mcp__enabled1__tool1", "mcp__enabled2__tool1"]);
  });

  it("handles undefined config gracefully", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: undefined,
      agentId: "main",
    });
    expect(tools).toEqual([]);
  });

  it("handles null mcpServers gracefully", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: { mcpServers: null } as any,
      agentId: "main",
    });
    expect(tools).toEqual([]);
  });

  it("handles server returning null tools array", async () => {
    mockListTools.mockResolvedValue({ tools: null });

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toEqual([]);
  });

  it("handles server returning undefined tools array", async () => {
    mockListTools.mockResolvedValue({});

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          test: { command: "echo" },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toEqual([]);
  });

  it("skips servers with explicitly enabled: false even with valid config", async () => {
    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: {
          validButDisabled: {
            command: "echo",
            args: ["valid"],
            enabled: false,
          },
        },
      } as any,
      agentId: "main",
    });

    expect(tools).toEqual([]);
    // Should not even attempt to connect
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("normalizes agent ID for state management", async () => {
    await resolveMcpToolsForAgent({
      config: {
        mcpServers: { test: { command: "echo" } },
      } as any,
      agentId: "  MAIN  ",
    });

    expect(agentStates.has("main")).toBe(true);
    expect(agentStates.has("MAIN")).toBe(false);
    expect(agentStates.has("  MAIN  ")).toBe(false);
  });

  it("uses 'main' for empty agent ID", async () => {
    await resolveMcpToolsForAgent({
      config: {
        mcpServers: { test: { command: "echo" } },
      } as any,
      agentId: "",
    });

    expect(agentStates.has("main")).toBe(true);
  });

  it("clears cached toolsPromise when no tools are loaded", async () => {
    mockConnect.mockRejectedValue(new Error("Connection failed"));

    await resolveMcpToolsForAgent({
      config: {
        mcpServers: { failing: { command: "bad" } },
      } as any,
      agentId: "main",
    });

    const state = agentStates.get("main");
    expect(state?.toolsPromise).toBeNull();
  });

  it("handles listTools timeout via abort signal", async () => {
    mockListTools.mockImplementation(async (signal: AbortSignal) => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await new Promise((r) => setTimeout(r, 100));
      return { tools: [] };
    });

    const controller = new AbortController();
    controller.abort();

    const tools = await resolveMcpToolsForAgent({
      config: {
        mcpServers: { test: { command: "echo" } },
      } as any,
      agentId: "main",
      abortSignal: controller.signal,
    });

    expect(tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool execution edge cases
// ---------------------------------------------------------------------------

describe("MCP tool execution edge cases", () => {
  const mockConnection = {
    callTool: vi.fn(),
  } as any;

  const baseTool = {
    name: "test_tool",
    description: "Test tool",
    inputSchema: { type: "object" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles callTool returning empty content array", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    const result = await tool.execute("call-1", {}, undefined);

    expect(result.content).toEqual([]);
  });

  it("handles callTool returning content with mixed types", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [
        { type: "text", text: "Line 1" },
        { type: "image", data: "base64img", mimeType: "image/png" },
        { type: "text", text: "Line 2" },
      ],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    const result = await tool.execute("call-1", {}, undefined);

    expect(result.content).toEqual([
      { type: "text", text: "Line 1" },
      { type: "image", data: "base64img", mimeType: "image/png" },
      { type: "text", text: "Line 2" },
    ]);
  });

  it("handles callTool throwing network error", async () => {
    mockConnection.callTool.mockRejectedValue(new Error("Network unreachable"));

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    await expect(tool.execute("call-1", {}, undefined)).rejects.toThrow("Network unreachable");
  });

  it("handles deeply nested params", async () => {
    mockConnection.callTool.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
    });

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "test",
      tool: baseTool,
      connection: mockConnection,
    });

    const deepParams = {
      level1: {
        level2: {
          level3: {
            value: "deep",
          },
        },
      },
      array: [1, 2, { nested: true }],
    };

    await tool.execute("call-1", deepParams, undefined);

    expect(mockConnection.callTool).toHaveBeenCalledWith({
      toolName: "test_tool",
      args: deepParams,
      signal: undefined,
    });
  });

  it("includes original result in details", async () => {
    const originalResult = {
      content: [{ type: "text", text: "Result" }],
      _meta: { requestId: 123 },
    };
    mockConnection.callTool.mockResolvedValue(originalResult);

    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "myserver",
      tool: baseTool,
      connection: mockConnection,
    });

    const result = await tool.execute("call-456", {}, undefined);

    expect(result.details).toMatchObject({
      toolCallId: "call-456",
      serverId: "myserver",
      tool: "test_tool",
      result: originalResult,
    });
  });
});

// ---------------------------------------------------------------------------
// Tool label handling
// ---------------------------------------------------------------------------

describe("Tool label handling", () => {
  const mockConnection = { callTool: vi.fn() } as any;

  it("uses server label when provided", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "gh",
      serverLabel: "GitHub API",
      tool: { name: "create_issue", inputSchema: {} },
      connection: mockConnection,
    });

    expect(tool.label).toBe("mcp:GitHub API:create_issue");
  });

  it("falls back to serverId when serverLabel is empty", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      serverLabel: "",
      tool: { name: "create_issue", inputSchema: {} },
      connection: mockConnection,
    });

    expect(tool.label).toBe("mcp:github:create_issue");
  });

  it("falls back to serverId when serverLabel is whitespace only", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "github",
      serverLabel: "   ",
      tool: { name: "create_issue", inputSchema: {} },
      connection: mockConnection,
    });

    expect(tool.label).toBe("mcp:github:create_issue");
  });

  it("trims serverLabel whitespace", () => {
    const tool = buildMcpPiTool({
      agentId: "main",
      serverId: "gh",
      serverLabel: "  GitHub API  ",
      tool: { name: "create_issue", inputSchema: {} },
      connection: mockConnection,
    });

    expect(tool.label).toBe("mcp:GitHub API:create_issue");
  });
});

// ---------------------------------------------------------------------------
// STDIO transport configuration
// ---------------------------------------------------------------------------

describe("STDIO transport configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("passes cwd to stdio transport", async () => {
    const server = {
      command: "node",
      args: ["server.js"],
      cwd: "/app/mcp-server",
    } as any;
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/app/mcp-server",
      }),
    );
  });

  it("passes stderr option to stdio transport", async () => {
    const server = {
      command: "node",
      args: ["server.js"],
      stderr: "inherit" as const,
    } as any;
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        stderr: "inherit",
      }),
    );
  });

  it("handles server without args", async () => {
    const server = { command: "simple-mcp-server" } as any;
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "simple-mcp-server",
        args: undefined,
      }),
    );
  });

  it("does not merge env when none provided", async () => {
    const server = { command: "echo" } as any;
    const conn = new McpConnection({ serverId: "test", server });
    await conn.connect();

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        env: undefined,
      }),
    );
  });
});
