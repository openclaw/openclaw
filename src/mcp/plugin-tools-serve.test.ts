import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HookContext,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
const connectToolsMcpServerToStdioMock = vi.hoisted(() => vi.fn());
const createToolsMcpServerMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ plugins: { enabled: true } })));
const ensureStandalonePluginToolRegistryLoadedMock = vi.hoisted(() => vi.fn());
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    ensureStandalonePluginToolRegistryLoaded: ensureStandalonePluginToolRegistryLoadedMock,
    resolvePluginTools: resolvePluginToolsMock,
  };
});

vi.mock("./tools-stdio-server.js", () => ({
  connectToolsMcpServerToStdio: connectToolsMcpServerToStdioMock,
  createToolsMcpServer: createToolsMcpServerMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayTool.mockReset();
  connectToolsMcpServerToStdioMock.mockReset();
  createToolsMcpServerMock.mockClear();
  ensureStandalonePluginToolRegistryLoadedMock.mockReset();
  getRuntimeConfigMock.mockClear();
  resolvePluginToolsMock.mockReset();
  resolvePluginToolsMock.mockReturnValue([]);
  routeLogsToStderrMock.mockReset();
  resetGlobalHookRunner();
});

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function requireToolPolicyParams(mock: ReturnType<typeof vi.fn>) {
  const params = requireFirstMockCall(mock.mock.calls, "plugin tool policy")[0] as
    | { toolAllowlist?: string[]; toolDenylist?: string[] }
    | undefined;
  if (!params) {
    throw new Error("expected plugin tool policy params");
  }
  return params;
}

function createPluginToolWithUnreadableField(
  field: "description" | "parameters",
  params: { name: string; execute: ReturnType<typeof vi.fn> },
): AnyAgentTool {
  const tool = {
    name: params.name,
    description: "Unreadable plugin tool.",
    parameters: { type: "object", properties: {} },
    execute: params.execute,
  };
  Object.defineProperty(tool, field, {
    enumerable: true,
    get() {
      throw new Error(`${field} getter exploded`);
    },
  });
  return tool as unknown as AnyAgentTool;
}

describe("plugin tools MCP server", () => {
  it("routes logs to stderr before resolving tools for stdio", async () => {
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "memory_recall",
        label: "Recall memory",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ]);

    await servePluginToolsMcp();

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(ensureStandalonePluginToolRegistryLoadedMock).toHaveBeenCalledWith({
      context: { config: { plugins: { enabled: true } } },
    });
    expect(resolvePluginToolsMock).toHaveBeenCalledTimes(1);
    expect(ensureStandalonePluginToolRegistryLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(routeLogsToStderrMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connectToolsMcpServerToStdioMock).toHaveBeenCalledOnce();
  });

  it("threads global plugin tool policy into plugin resolution", async () => {
    getRuntimeConfigMock.mockReturnValueOnce({
      plugins: { enabled: true },
      tools: {
        alsoAllow: ["memory_search"],
        deny: ["memory_forget"],
      },
    } as never);
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");

    await servePluginToolsMcp();

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolAllowlist).toContain("memory_search");
    expect(loadPolicy.toolDenylist).toEqual(["memory_forget"]);
    const resolvePolicy = requireToolPolicyParams(resolvePluginToolsMock);
    expect(resolvePolicy.toolAllowlist).toContain("memory_search");
    expect(resolvePolicy.toolDenylist).toEqual(["memory_forget"]);
  });

  it("lists registered plugin tools and serializes non-array tool content", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const listed = await handlers.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("memory_recall");
    expect(listed.tools[0]?.description).toBe("Recall stored memory");
    const inputSchema = listed.tools[0]?.inputSchema as
      | { type?: unknown; required?: unknown }
      | undefined;
    expect(inputSchema?.type).toBe("object");
    expect(inputSchema?.required).toEqual(["query"]);

    const result = await handlers.callTool({
      name: "memory_recall",
      arguments: { query: "remember this" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const executeCall = requireFirstMockCall(execute.mock.calls, "plugin tool execute");
    const requestId = executeCall[0];
    expect(typeof requestId).toBe("string");
    expect((requestId as string).startsWith("mcp-")).toBe(true);
    expect(Number.isSafeInteger(Number((requestId as string).slice("mcp-".length)))).toBe(true);
    expect(executeCall[1]).toEqual({ query: "remember this" });
    expect(executeCall[2]).toBeUndefined();
    expect(executeCall[3]).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
  });

  it("quarantines unreadable plugin tool descriptors before MCP listing and wrapping", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const healthyExecute = vi.fn().mockResolvedValue({ content: "healthy" });
    const unreadableParametersExecute = vi.fn();
    const unreadableDescriptionExecute = vi.fn();
    const handlers = createPluginToolsMcpHandlers([
      {
        name: "memory_recall",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: healthyExecute,
      } as unknown as AnyAgentTool,
      createPluginToolWithUnreadableField("parameters", {
        name: "bad_parameters",
        execute: unreadableParametersExecute,
      }),
      createPluginToolWithUnreadableField("description", {
        name: "bad_description",
        execute: unreadableDescriptionExecute,
      }),
    ]);

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("bad_parameters.parameters is unreadable"),
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("bad_description.description is unreadable"),
    );

    const healthy = await handlers.callTool({ name: "memory_recall", arguments: {} });
    expect(healthy.content).toEqual([{ type: "text", text: "healthy" }]);
    expect(healthyExecute).toHaveBeenCalledTimes(1);
    expect(unreadableParametersExecute).not.toHaveBeenCalled();
    expect(unreadableDescriptionExecute).not.toHaveBeenCalled();
  });

  it("quarantines unreadable plugin tool entries while keeping healthy siblings", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const hiddenExecute = vi.fn();
    const tools = [
      {
        name: "memory_recall",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      } as unknown as AnyAgentTool,
      {
        name: "hidden_bad_tool",
        description: "Hidden bad tool",
        parameters: { type: "object", properties: {} },
        execute: hiddenExecute,
      } as unknown as AnyAgentTool,
    ];
    Object.defineProperty(tools, "1", {
      configurable: true,
      get() {
        throw new Error("tool entry getter exploded");
      },
    });

    const handlers = createPluginToolsMcpHandlers(tools);
    const listed = await handlers.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("tool[1] is unreadable"));
    expect(hiddenExecute).not.toHaveBeenCalled();
  });

  it("quarantines runtime-incompatible plugin tool schemas before MCP listing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const badExecute = vi.fn();
    const handlers = createPluginToolsMcpHandlers([
      {
        name: "memory_recall",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      } as unknown as AnyAgentTool,
      {
        name: "dofbot_move_angles",
        description: "Move Dofbot angles",
        parameters: { type: "array", items: { type: "number" } },
        execute: badExecute,
      } as unknown as AnyAgentTool,
    ]);

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["memory_recall"]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('dofbot_move_angles.parameters.type must be "object"'),
    );

    const result = await handlers.callTool({ name: "dofbot_move_angles", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Unknown tool: dofbot_move_angles" }]);
    expect(badExecute).not.toHaveBeenCalled();
  });

  it("sanitizes quarantined plugin tool diagnostics before writing stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const badName = "bad_tool\n\u001b]0;pwned\u0007";

    createPluginToolsMcpHandlers([
      {
        name: badName,
        description: "Terminal escape fixture",
        parameters: { type: "array", items: { type: "string" } },
        execute: vi.fn(),
      } as unknown as AnyAgentTool,
    ]);

    const rawMessage = String(stderr.mock.calls[0]?.[0] ?? "");
    expect(rawMessage.endsWith("\n")).toBe(true);
    const body = rawMessage.slice(0, -1);
    expect(body).not.toContain("\n");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\u0007");
    expect(body).toContain("bad_tool");
    expect(body).toContain('bad_tool.parameters.type must be "object"');
  });

  it("keeps parameter-free plugin tools as empty-object MCP schemas", async () => {
    const tool = {
      name: "memory_ping",
      description: "Ping memory",
      execute: vi.fn(),
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const listed = await handlers.listTools();

    expect(listed.tools).toEqual([
      {
        name: "memory_ping",
        description: "Ping memory",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("adds the MCP-required object root type to accepted typeless schemas", async () => {
    const tool = {
      name: "memory_search",
      description: "Search memory",
      parameters: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute: vi.fn(),
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const listed = await handlers.listTools();

    expect(listed.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
  });

  it("serializes plugin tool results that do not use the MCP content envelope", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "kitchen-sink-search",
      results: [{ title: "Kitchen Sink image fixture" }],
    });
    const tool = {
      name: "kitchen_sink_search",
      description: "Search Kitchen Sink fixture content",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "kitchen_sink_search",
      arguments: { query: "kitchen sink" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          provider: "kitchen-sink-search",
          results: [{ title: "Kitchen Sink image fixture" }],
        }),
      },
    ]);
  });

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      name: "memory_forget",
      description: "Forget memory",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([failingTool]);
    const unknown = await handlers.callTool({
      name: "missing_tool",
      arguments: {},
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toEqual([{ type: "text", text: "Unknown tool: missing_tool" }]);

    const failed = await handlers.callTool({
      name: "memory_forget",
      arguments: {},
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "Tool error: boom" }]);
  });

  it("reports approval requirements without opening plugin approvals on the MCP bridge", async () => {
    let hookCalls = 0;
    const onResolution = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            hookCalls += 1;
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
                onResolution,
              },
            };
          },
        },
      ]),
    );
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "memory_store",
      arguments: { text: "remember this" },
    });
    expect(hookCalls).toBe(1);
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool error: Approval required" }]);
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
  });

  it("switches pre-wrapped plugin tools to approval report mode on the MCP bridge", async () => {
    const onResolution = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const originalContext = {
      agentId: "agent-with-plugins",
      sessionKey: "session-with-plugins",
    } satisfies HookContext;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async (_event, ctx) => {
            const hookContext = ctx as HookContext | undefined;
            if (hookContext?.sessionKey !== originalContext.sessionKey) {
              return undefined;
            }
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
                onResolution,
              },
            };
          },
        },
      ]),
    );
    callGatewayTool.mockRejectedValue(new Error("gateway unavailable"));
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "memory_store",
        description: "Store memory",
        parameters: { type: "object", properties: {} },
        execute,
      } as unknown as AnyAgentTool,
      originalContext,
    );

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "memory_store",
      arguments: { text: "remember this" },
    });
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool error: Approval required" }]);
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);

    await expect(tool.execute("agent-tool-call", { text: "remember this" })).rejects.toThrow(
      "Plugin approval required (gateway unavailable)",
    );
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenCalledTimes(2);
    expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);
    expect(execute).not.toHaveBeenCalled();
  });
});
