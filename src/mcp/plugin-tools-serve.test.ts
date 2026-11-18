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
import type { OpenClawConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import {
  createCodexSupervisionToolsMcpServer,
  serveCodexSupervisionToolsMcp,
} from "./codex-supervision-tools-serve.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";
import { acquirePluginToolsForMcp, servePluginToolsMcp } from "./plugin-tools-serve.js";
import { createTool, textResult, withMcpConnection } from "./tools-mcp.test-support.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
const getRuntimeConfigMock = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({ plugins: { enabled: true } })),
);
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

vi.mock("../logging/console.js", async (original) => ({
  ...(await original<typeof import("../logging/console.js")>()),
  routeLogsToStderr: vi.fn(),
}));

vi.mock("../plugins/tools.js", async (original) => ({
  ...(await original<typeof import("../plugins/tools.js")>()),
  acquireStandalonePluginToolRegistry: acquireStandalonePluginToolRegistryMock,
}));

vi.mock("./tools-stdio-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-stdio-server.js")>();
  const serve: typeof actual.serveRegisteredToolsMcpServer = async (params) => {
    const { LegacyPluginSdkResourceHost } = await import("../plugins/legacy-sdk-resource-host.js");
    const host = new LegacyPluginSdkResourceHost();
    const acquisition = await host.run(params.acquireRegistry);
    const server = params.createServer(acquisition.resolveTools(), host);
    await server.close();
    await acquisition.release();
    await host.close();
  };
  return { ...actual, serveRegisteredToolsMcpServer: serve };
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
  vi.unstubAllEnvs();
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
  beforeToolCall(handler);
  return { handler, onResolution };
}

const stored = () => vi.fn().mockResolvedValue({ content: "Stored." });
function beforeToolCall(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
}

describe("plugin tools MCP server", () => {
  it("rejects a non-agent session identity from the managed bridge", async () => {
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "research-session");
    await expect(
      acquirePluginToolsForMcp({
        config: { plugins: { enabled: true } } as never,
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

    const config = {
      plugins: { enabled: true },
      tools: { allow: ["plugin_allowed", "plugin_denied"], deny: ["plugin_globally_denied"] },
      agents: {
        entries: {
          research: { tools: { allow: ["plugin_allowed"], deny: ["plugin_denied"] } },
        },
      },
    } as never;
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "agent:research:acp:session-1");
    const acquisition = await acquirePluginToolsForMcp({ config });
    const handlers = createPluginToolsMcpHandlers(acquisition.resolveTools());

    try {
      await expect(handlers.listTools()).resolves.toMatchObject({
        tools: [{ name: "plugin_allowed" }],
      });
      await expect(handlers.callTool({ name: "plugin_denied" })).resolves.toMatchObject({
        isError: true,
        ...textResult("Unknown tool: plugin_denied"),
      });
      expect(deniedExecute).not.toHaveBeenCalled();

      await expect(handlers.callTool({ name: "plugin_allowed" })).resolves.toMatchObject(
        textResult("Stored."),
      );
      expect(allowedExecute).toHaveBeenCalledOnce();

      expect(acquireStandalonePluginToolRegistryMock.mock.calls[0]?.[0]).toMatchObject({
        context: { config, agentId: "research", sessionKey: "agent:research:acp:session-1" },
        toolAllowlist: ["plugin_allowed", "plugin_denied"],
        toolDenylist: ["plugin_globally_denied", "plugin_denied"],
        suppressNameConflicts: true,
      });
      expect(resolvePluginToolsMock).toHaveBeenCalledOnce();
    } finally {
      await acquisition.release();
    }
  });

  it("uses unique ids and releases execution tracking through the scheduler alias", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const runId = "run-direct-mcp";
    beforeToolCall(async () => ({ params: { text: "adjusted" } }));
    const executeSuccess = stored();
    const executeFailure = vi.fn().mockRejectedValue(new Error("unavailable"));
    const handlers = createPluginToolsMcpHandlers([
      wrapToolWithBeforeToolCallHook(createTool("automations", executeSuccess), {
        runId,
        sessionKey: "session-direct-mcp",
      }),
      createTool("memory_forget", executeFailure),
    ]);

    for (let index = 0; index < 32; index += 1) {
      await handlers.callTool({ name: "cron", arguments: { text: "original" } });
      await handlers.callTool({ name: "memory_forget", arguments: { index } });
    }

    expect(executeSuccess).toHaveBeenCalledTimes(32);
    expect(executeFailure).toHaveBeenCalledTimes(32);
    expect(executeSuccess.mock.calls[0]?.[1]).toEqual({ text: "adjusted" });
    const toolCallIds = [...executeSuccess.mock.calls, ...executeFailure.mock.calls].map(
      ([toolCallId]) => String(toolCallId),
    );
    expect(new Set(toolCallIds).size).toBe(toolCallIds.length);
    for (const toolCallId of toolCallIds) {
      expect(consumeTrackedToolExecutionStarted(toolCallId)).toBeUndefined();
      expect(consumeTrackedToolExecutionStarted(toolCallId, runId)).toBeUndefined();
      expect(consumeAdjustedParamsForToolCall(toolCallId)).toBeUndefined();
      expect(consumeAdjustedParamsForToolCall(toolCallId, runId)).toBeUndefined();
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

      const result = await createPluginToolsMcpHandlers([tool]).callTool({
        name: "memory_store",
        arguments: { text: "remember this" },
      });
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result).toEqual({
        isError: true,
        ...textResult("Tool error: Approval required"),
      });
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

describe("Codex supervision MCP server", () => {
  const names = [
    "codex_endpoint_probe",
    "codex_sessions_list",
    "codex_session_read",
    "codex_session_send",
    "codex_session_interrupt",
  ];
  const tools = () => names.map((name) => createTool(name, vi.fn<AnyAgentTool["execute"]>()));

  it("preserves endpoint config and translates legacy env policy at the standalone boundary", async () => {
    resolvePluginToolsMock.mockReturnValue(tools());
    await serveCodexSupervisionToolsMcp();
    expect(acquireStandalonePluginToolRegistryMock.mock.calls[0]?.[0]?.context.senderIsOwner).toBe(
      true,
    );
    vi.stubEnv("OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS", "1");
    vi.stubEnv("OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS", "1");
    const appServer = { transport: "websocket", url: "ws://127.0.0.1:4500" };
    const config = {
      plugins: {
        allow: [" CODEX "],
        deny: ["CoDeX"],
        entries: { " CODEX ": { config: { appServer, supervision: { enabled: false } } } },
      },
    };
    const original = structuredClone(config);
    getRuntimeConfigMock.mockReturnValue(config);
    await serveCodexSupervisionToolsMcp();
    await withMcpConnection(
      createCodexSupervisionToolsMcpServer({ tools: tools() }),
      async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
      },
    );
    expect(acquireStandalonePluginToolRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ senderIsOwner: true }) }),
    );
    const plugins =
      acquireStandalonePluginToolRegistryMock.mock.calls.at(-1)?.[0]?.context.config?.plugins;
    expect(plugins).toMatchObject({
      allow: ["codex"],
      deny: [],
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: original.plugins.entries[" CODEX "].config.appServer,
            supervision: { enabled: true, allowRawTranscripts: true, allowWriteControls: true },
          },
        },
      },
    });
    expect(plugins?.entries).not.toHaveProperty(" CODEX ");
    expect(config).toEqual(original);
  });
});
