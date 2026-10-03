// Plugin MCP serve tests cover serving plugin tools over MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeAdjustedParamsForToolCall,
  type HookContext,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import {
  consumeTrackedToolExecutionStarted,
  resetAdjustedParamsByToolCallIdForTests,
} from "../agents/agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
const connectToolsMcpServerToStdioMock = vi.hoisted(() => vi.fn());
const createToolsMcpServerMock = vi.hoisted(() =>
  vi.fn<typeof import("./tools-stdio-server.js").createToolsMcpServer>(),
);
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ plugins: { enabled: true } })));
const acquireStandalonePluginToolRegistryMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/tools.js").acquireStandalonePluginToolRegistry>(),
);
const releasePluginToolsMock = vi.hoisted(() => vi.fn(async () => {}));
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
    acquireStandalonePluginToolRegistry: acquireStandalonePluginToolRegistryMock,
  };
});

vi.mock("./tools-stdio-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-stdio-server.js")>();
  createToolsMcpServerMock.mockImplementation(actual.createToolsMcpServer);
  const serve: typeof actual.serveRegisteredToolsMcpServer = async (params) => {
    const { LegacyPluginSdkResourceHost } = await import("../plugins/legacy-sdk-resource-host.js");
    const host = new LegacyPluginSdkResourceHost();
    const acquisition = await host.run(params.acquireRegistry);
    const server = params.createServer(acquisition.resolveTools(), host);
    try {
      await connectToolsMcpServerToStdioMock(server);
    } finally {
      await server.close();
      await acquisition.release();
      await host.close();
    }
  };
  return {
    ...actual,
    createToolsMcpServer: createToolsMcpServerMock,
    serveRegisteredToolsMcpServer: serve,
  };
});

acquireStandalonePluginToolRegistryMock.mockImplementation(async () => ({
  resolveTools: resolvePluginToolsMock,
  release: releasePluginToolsMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayTool.mockReset();
  connectToolsMcpServerToStdioMock.mockReset();
  createToolsMcpServerMock.mockClear();
  acquireStandalonePluginToolRegistryMock.mockReset().mockImplementation(async () => ({
    resolveTools: resolvePluginToolsMock,
    release: releasePluginToolsMock,
  }));
  releasePluginToolsMock.mockClear();
  getRuntimeConfigMock.mockClear();
  resolvePluginToolsMock.mockReset();
  resolvePluginToolsMock.mockReturnValue([]);
  routeLogsToStderrMock.mockReset();
  resetAdjustedParamsByToolCallIdForTests();
  resetGlobalHookRunner();
});

function createTool(
  name: string,
  execute: AnyAgentTool["execute"],
  parameters = Type.Object({}),
  description = name,
): AnyAgentTool {
  return { name, label: name, description, parameters, execute };
}

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

describe("plugin tools MCP server", () => {
  it.each([
    { agentSessionKey: "agent:research:acp:session-1", agentId: undefined, owner: "research" },
    { agentSessionKey: "global", agentId: "work", owner: "work" },
  ])(
    "passes $agentSessionKey owner into plugin tool factories",
    async ({ agentSessionKey, agentId, owner }) => {
      const { acquirePluginToolsForMcp } = await import("./plugin-tools-serve.js");
      const runtimeRegistry = createMockPluginRegistry([]);
      acquireStandalonePluginToolRegistryMock.mockResolvedValue({
        registry: runtimeRegistry,
        resolveTools: resolvePluginToolsMock,
        release: releasePluginToolsMock,
      });
      const config = { plugins: { enabled: true } } as never;

      const acquisition = await acquirePluginToolsForMcp({ config, agentSessionKey, agentId });
      acquisition.resolveTools();
      await acquisition.release();

      const expectedContext = {
        config,
        agentId: owner,
        sessionKey: agentSessionKey,
      };
      expect(acquireStandalonePluginToolRegistryMock).toHaveBeenCalledWith({
        context: expectedContext,
        suppressNameConflicts: true,
      });
      expect(resolvePluginToolsMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a non-agent session identity from the managed bridge", async () => {
    const { acquirePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    await expect(
      acquirePluginToolsForMcp({
        config: { plugins: { enabled: true } } as never,
        agentSessionKey: "research-session",
      }),
    ).rejects.toThrow("must be a canonical agent session key");
  });

  it("routes logs to stderr before resolving tools for stdio", async () => {
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");
    const runtimeRegistry = createMockPluginRegistry([]);
    acquireStandalonePluginToolRegistryMock.mockResolvedValue({
      registry: runtimeRegistry,
      resolveTools: resolvePluginToolsMock,
      release: releasePluginToolsMock,
    });
    resolvePluginToolsMock.mockReturnValue([createTool("memory_recall", vi.fn())]);

    await servePluginToolsMcp();

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(acquireStandalonePluginToolRegistryMock).toHaveBeenCalledWith({
      context: { config: { plugins: { enabled: true } } },
      suppressNameConflicts: true,
    });
    expect(resolvePluginToolsMock).toHaveBeenCalledTimes(1);
    expect(acquireStandalonePluginToolRegistryMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(routeLogsToStderrMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connectToolsMcpServerToStdioMock).toHaveBeenCalledOnce();
  });

  it("threads agentless global plugin tool policy into plugin resolution", async () => {
    getRuntimeConfigMock.mockReturnValueOnce({
      plugins: { enabled: true },
      tools: {
        alsoAllow: ["memory_search"],
        deny: ["memory_forget"],
      },
    } as never);
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");

    await servePluginToolsMcp();

    const loadPolicy = requireToolPolicyParams(acquireStandalonePluginToolRegistryMock);
    expect(loadPolicy.toolAllowlist).toContain("memory_search");
    expect(loadPolicy.toolDenylist).toEqual(["memory_forget"]);
  });

  it("enforces global and managed-agent plugin tool policy", async () => {
    const deniedExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "denied executor ran" }],
    });
    const allowedExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "allowed executor ran" }],
    });
    resolvePluginToolsMock.mockReturnValue([
      createTool("plugin_allowed", allowedExecute),
      createTool("plugin_denied", deniedExecute),
    ]);
    const { acquirePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const acquisition = await acquirePluginToolsForMcp({
      config: {
        plugins: { enabled: true },
        tools: {
          allow: ["plugin_allowed", "plugin_denied"],
          deny: ["plugin_globally_denied"],
        },
        agents: {
          list: [
            {
              id: "research",
              tools: { allow: ["plugin_allowed"], deny: ["plugin_denied"] },
            },
          ],
        },
      } as never,
      agentSessionKey: "agent:research:acp:session-1",
    });
    const handlers = createPluginToolsMcpHandlers(acquisition.resolveTools());

    try {
      await expect(handlers.listTools()).resolves.toMatchObject({
        tools: [{ name: "plugin_allowed" }],
      });
      await expect(handlers.callTool({ name: "plugin_denied" })).resolves.toMatchObject({
        isError: true,
        content: [{ text: "Unknown tool: plugin_denied" }],
      });
      expect(deniedExecute).not.toHaveBeenCalled();

      await expect(handlers.callTool({ name: "plugin_allowed" })).resolves.toMatchObject({
        content: [{ text: "allowed executor ran" }],
      });
      expect(allowedExecute).toHaveBeenCalledOnce();

      expect(requireToolPolicyParams(acquireStandalonePluginToolRegistryMock)).toMatchObject({
        toolAllowlist: ["plugin_allowed", "plugin_denied"],
        toolDenylist: ["plugin_globally_denied", "plugin_denied"],
      });
    } finally {
      await acquisition.release();
    }
  });

  it("lists registered plugin tools and serializes non-array tool content", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = createTool(
      "memory_recall",
      execute,
      Type.Object({ query: Type.String() }),
      "Recall stored memory",
    );

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
    expect(requestId).toMatch(
      /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(executeCall[1]).toEqual({ query: "remember this" });
    expect(executeCall[2]).toBeUndefined();
    expect(executeCall[3]).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
  });

  it("uses unique ids and releases execution tracking through the scheduler alias", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const executeSuccess = vi.fn().mockResolvedValue({ content: "Stored." });
    const executeFailure = vi.fn().mockRejectedValue(new Error("unavailable"));
    const handlers = createPluginToolsMcpHandlers([
      createTool("automations", executeSuccess),
      createTool("memory_forget", executeFailure),
    ]);

    for (let index = 0; index < 32; index += 1) {
      await handlers.callTool({ name: "cron", arguments: { index } });
      await handlers.callTool({ name: "memory_forget", arguments: { index } });
    }

    expect(executeSuccess).toHaveBeenCalledTimes(32);
    expect(executeFailure).toHaveBeenCalledTimes(32);
    const toolCallIds = [...executeSuccess.mock.calls, ...executeFailure.mock.calls].map(
      ([toolCallId]) => String(toolCallId),
    );
    expect(new Set(toolCallIds).size).toBe(toolCallIds.length);
    for (const toolCallId of toolCallIds) {
      expect(consumeTrackedToolExecutionStarted(toolCallId)).toBeUndefined();
      expect(consumeAdjustedParamsForToolCall(toolCallId)).toBeUndefined();
    }
  });

  it("delivers source-shaped images through a real MCP client", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "browser screenshot" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ],
    });
    const tool = createTool("browser_screenshot", execute);
    const { createToolsMcpServer } =
      await vi.importActual<typeof import("./tools-stdio-server.js")>("./tools-stdio-server.js");
    const server = createToolsMcpServer({ name: "plugin-tools-image-test", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "plugin-tools-image-test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "browser_screenshot", arguments: {} });
      expect(result.content).toEqual([
        { type: "text", text: "browser screenshot" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serializes plugin tool results that do not use the MCP content envelope", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "kitchen-sink-search",
      results: [{ title: "Kitchen Sink image fixture" }],
    });
    const tool = createTool(
      "kitchen_sink_search",
      execute,
      Type.Object({ query: Type.Optional(Type.String()) }),
    );

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

  it("keeps completed nonzero shell exits nonfatal through MCP", async () => {
    const content = [{ type: "text", text: "original tool result" }];
    const execute = vi.fn().mockResolvedValue({
      content,
      details: { status: "completed", exitCode: 23 },
    });
    const handlers = createPluginToolsMcpHandlers([createTool("result_probe", execute)]);

    const result = await handlers.callTool({ name: "result_probe", arguments: {} });

    expect(result.content).toEqual(content);
    expect(result.isError).toBeUndefined();
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

  it("releases run-scoped adjusted arguments after a pre-wrapped direct MCP call", async () => {
    const runId = "run-direct-mcp";
    const execute = vi.fn().mockResolvedValue({ content: "Stored." });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ params: { text: "adjusted" } }),
        },
      ]),
    );
    const tool = wrapToolWithBeforeToolCallHook(createTool("memory_store", execute), {
      runId,
      sessionKey: "session-direct-mcp",
    });

    const handlers = createPluginToolsMcpHandlers([tool]);
    await handlers.callTool({
      name: "memory_store",
      arguments: { text: "original" },
    });

    const executeCall = requireFirstMockCall(execute.mock.calls, "plugin tool execute");
    const toolCallId = String(executeCall[0]);
    expect(executeCall[1]).toEqual({ text: "adjusted" });
    expect(consumeAdjustedParamsForToolCall(toolCallId, runId)).toBeUndefined();
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
    const tool = createTool("memory_store", execute);

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
      createTool("memory_store", execute),
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
