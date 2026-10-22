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
import { acquirePluginToolsForMcp, servePluginToolsMcp } from "./plugin-tools-serve.js";
import { createTool, withMcpConnection } from "./tools-mcp.test-support.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
const connectToolsMcpServerToStdioMock = vi.hoisted(() => vi.fn());
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ plugins: { enabled: true } })));
const acquireStandalonePluginToolRegistryMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/tools.js").acquireStandalonePluginToolRegistry>(),
);
const releasePluginToolsMock = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));

// mock-isolation: gateway calls are controlled by this MCP transport fixture.
vi.mock("../agents/tools/gateway.js", () => ({ callGatewayTool }));

// mock-isolation: MCP tool fixtures provide config without starting a real config owner.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
  captureRuntimeConfigAsyncReader: () => async () => getRuntimeConfigMock(),
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: vi.fn(),
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
    serveRegisteredToolsMcpServer: serve,
  };
});

const acquireRegistry = async () => ({
  resolveTools: resolvePluginToolsMock,
  release: releasePluginToolsMock,
});
acquireStandalonePluginToolRegistryMock.mockImplementation(acquireRegistry);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  acquireStandalonePluginToolRegistryMock.mockImplementation(acquireRegistry);
  getRuntimeConfigMock.mockReturnValue({ plugins: { enabled: true } });
  resolvePluginToolsMock.mockReturnValue([]);
  resetAdjustedParamsByToolCallIdForTests();
  resetGlobalHookRunner();
});

function approvalHook(context?: HookContext) {
  const onResolution = vi.fn();
  const handler = vi.fn(async (_event: unknown, ctx: unknown) => {
    const hookContext = ctx as HookContext | undefined;
    if (context && hookContext?.sessionKey !== context.sessionKey) {
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
  });
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return { handler, onResolution };
}

const stored = () => vi.fn().mockResolvedValue({ content: "Stored." });

async function expectApprovalReported(tool: AnyAgentTool, execute: ReturnType<typeof vi.fn>) {
  const result = await createPluginToolsMcpHandlers([tool]).callTool({
    name: "memory_store",
    arguments: { text: "remember this" },
  });
  expect(callGatewayTool).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(result).toEqual({
    isError: true,
    content: [{ type: "text", text: "Tool error: Approval required" }],
  });
}

describe("plugin tools MCP server", () => {
  it.each([
    { agentSessionKey: "agent:research:acp:session-1", agentId: undefined, owner: "research" },
    { agentSessionKey: "global", agentId: "work", owner: "work" },
  ])(
    "passes $agentSessionKey owner into plugin tool factories",
    async ({ agentSessionKey, agentId, owner }) => {
      const config = { plugins: { enabled: true } } as never;

      const acquisition = await acquirePluginToolsForMcp({ config, agentSessionKey, agentId });
      acquisition.resolveTools();
      await acquisition.release();

      expect(acquireStandalonePluginToolRegistryMock).toHaveBeenCalledWith({
        context: { config, agentId: owner, sessionKey: agentSessionKey },
        suppressNameConflicts: true,
      });
      expect(resolvePluginToolsMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a non-agent session identity from the managed bridge", async () => {
    await expect(
      acquirePluginToolsForMcp({
        config: { plugins: { enabled: true } } as never,
        agentSessionKey: "research-session",
      }),
    ).rejects.toThrow("must be a canonical agent session key");
  });

  it("threads agentless global plugin tool policy into plugin resolution", async () => {
    getRuntimeConfigMock.mockReturnValueOnce({
      plugins: { enabled: true },
      tools: { alsoAllow: ["memory_search"], deny: ["memory_forget"] },
    } as never);

    await servePluginToolsMcp();

    expect(acquireStandalonePluginToolRegistryMock.mock.calls[0]?.[0]).toMatchObject({
      toolAllowlist: expect.arrayContaining(["memory_search"]),
      toolDenylist: ["memory_forget"],
    });
  });

  it("enforces global and managed-agent plugin tool policy", async () => {
    const deniedExecute = stored();
    const allowedExecute = stored();
    resolvePluginToolsMock.mockReturnValue([
      createTool("plugin_allowed", allowedExecute),
      createTool("plugin_denied", deniedExecute),
    ]);

    const acquisition = await acquirePluginToolsForMcp({
      config: {
        plugins: { enabled: true },
        tools: { allow: ["plugin_allowed", "plugin_denied"], deny: ["plugin_globally_denied"] },
        agents: {
          entries: {
            research: { tools: { allow: ["plugin_allowed"], deny: ["plugin_denied"] } },
          },
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
        content: [{ text: "Stored." }],
      });
      expect(allowedExecute).toHaveBeenCalledOnce();

      expect(acquireStandalonePluginToolRegistryMock.mock.calls[0]?.[0]).toMatchObject({
        toolAllowlist: ["plugin_allowed", "plugin_denied"],
        toolDenylist: ["plugin_globally_denied", "plugin_denied"],
      });
    } finally {
      await acquisition.release();
    }
  });

  it("uses unique ids and releases execution tracking through the scheduler alias", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const executeSuccess = stored();
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
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    });
    const tool = createTool("browser_screenshot", execute);
    const { createToolsMcpServer } =
      await vi.importActual<typeof import("./tools-stdio-server.js")>("./tools-stdio-server.js");
    const server = createToolsMcpServer({ name: "plugin-tools-image-test", tools: [tool] });
    await withMcpConnection(server, async (client) => {
      const result = await client.callTool({ name: "browser_screenshot", arguments: {} });
      expect(result.content).toEqual([
        { type: "text", text: "browser screenshot" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
    });
  });

  it("serializes plugin tool results outside the MCP content envelope", async () => {
    const handlers = createPluginToolsMcpHandlers([
      createTool("search", vi.fn().mockResolvedValue({ answer: 42 })),
    ]);
    const result = await handlers.callTool({ name: "search" });
    expect(result.content).toEqual([{ type: "text", text: '{"answer":42}' }]);
  });

  it("releases run-scoped adjusted arguments after a pre-wrapped direct MCP call", async () => {
    const runId = "run-direct-mcp";
    const execute = stored();
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
    await handlers.callTool({ name: "memory_store", arguments: { text: "original" } });

    const [toolCallId, params] = execute.mock.calls[0] ?? [];
    expect(execute).toHaveBeenCalledOnce();
    expect(params).toEqual({ text: "adjusted" });
    expect(consumeAdjustedParamsForToolCall(String(toolCallId), runId)).toBeUndefined();
  });

  it.each([false, true])(
    "reports approvals without opening them (pre-wrapped: %s)",
    async (wrapped) => {
      const execute = stored();
      const context = {
        agentId: "agent-with-plugins",
        sessionKey: "session-with-plugins",
      } satisfies HookContext;
      const { handler, onResolution } = approvalHook(wrapped ? context : undefined);
      const original = createTool("memory_store", execute);
      const tool = wrapped ? wrapToolWithBeforeToolCallHook(original, context) : original;
      if (wrapped) {
        callGatewayTool.mockRejectedValue(new Error("gateway unavailable"));
      }

      await expectApprovalReported(tool, execute);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(onResolution).toHaveBeenCalledTimes(1);
      expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);
      if (wrapped) {
        await expect(tool.execute("agent-tool-call", { text: "remember this" })).rejects.toThrow(
          "Plugin approval required (gateway unavailable)",
        );
        expect(callGatewayTool).toHaveBeenCalledTimes(1);
        expect(onResolution).toHaveBeenCalledTimes(2);
        expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );
});
