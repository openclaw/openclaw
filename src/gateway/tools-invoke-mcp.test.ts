import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withToolsInvokeTestState } from "./tools-invoke-http.test-support.js";
import { invokeGatewayTool } from "./tools-invoke-shared.js";

const runtime = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  coreExecute: vi.fn(async () => ({ core: true })),
  mcpExecute: vi.fn(async () => ({ content: [{ type: "text", text: "meetings" }] })),
  diagnostics: undefined as { serverName: string; message: string }[] | undefined,
  acquire: vi.fn(),
  materialize: vi.fn(),
  retire: vi.fn(async () => true),
  disposeMaterialized: vi.fn(async () => undefined),
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
// mock-isolation: Core tools stay inert; only configured MCP resolution is exercised.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async () => [
    {
      name: "session_status",
      parameters: { type: "object", properties: {} },
      execute: runtime.coreExecute,
    },
  ],
}));
vi.mock("../agents/agent-tools.js", () => ({ resolveToolLoopDetectionConfig: () => ({}) }));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: Record<string, unknown> }) => ({
    blocked: false,
    params,
  }),
}));
// mock-isolation: No MCP transport; the fixture stands in for a connected server's catalog.
vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  acquireSessionMcpRuntime: runtime.acquire,
  materializeBundleMcpToolsForRun: runtime.materialize,
  retireSessionMcpRuntime: runtime.retire,
}));

// Mirrors materialization: an MCP tool is a bundle-mcp plugin tool with MCP metadata.
function createMcpTool(toolName: string): AnyAgentTool {
  const tool = {
    name: `granola__${toolName}`,
    label: toolName,
    description: toolName,
    parameters: { type: "object", properties: {} },
    execute: runtime.mcpExecute,
  } as unknown as AnyAgentTool;
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: { serverName: "granola", safeServerName: "granola", toolName, operation: "tool" },
  });
  return tool;
}

const invoke = (name: string) =>
  invokeGatewayTool({
    cfg: runtime.cfg,
    input: { name, args: { limit: 3 } },
    senderIsOwner: true,
    toolCallIdPrefix: "rpc",
  });

beforeEach(() => {
  vi.clearAllMocks();
  runtime.diagnostics = undefined;
  runtime.cfg = {
    agents: { entries: { main: {} } },
    mcp: {
      servers: {
        granola: { url: "https://mcp.example.test/mcp" },
        other: { url: "https://other.example.test/mcp" },
      },
    },
  } as OpenClawConfig;
  runtime.acquire.mockImplementation(async () => ({ runtime: {} }));
  runtime.materialize.mockImplementation(async () => ({
    tools: runtime.diagnostics ? [] : [createMcpTool("list_meetings")],
    diagnostics: runtime.diagnostics,
    dispose: runtime.disposeMaterialized,
  }));
});

describe("tools.invoke configured MCP tools", () => {
  it("runs a configured MCP tool on a private single-server runtime", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke" }, async () => {
      const outcome = await invoke("granola__list_meetings");

      expect(outcome).toMatchObject({
        ok: true,
        toolName: "granola__list_meetings",
        source: "mcp",
        result: { content: [{ type: "text", text: "meetings" }] },
      });
      expect(runtime.mcpExecute).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 3 },
        expect.any(AbortSignal),
      );
      const [acquisition] = runtime.acquire.mock.calls[0] as [Record<string, unknown>];
      expect(acquisition.sessionId).toMatch(/^tools-invoke:/);
      expect(acquisition).not.toHaveProperty("sessionKey");
      expect(acquisition.toolDenylist).toEqual(["other__*"]);
      expect(runtime.retire).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: acquisition.sessionId }),
      );
      expect(runtime.disposeMaterialized).toHaveBeenCalledOnce();
    });
  });

  it("applies configured tool policy to MCP tools", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-deny" }, async () => {
      runtime.cfg = { ...runtime.cfg, tools: { deny: ["granola__list_meetings"] } };

      const outcome = await invoke("granola__list_meetings");

      expect(outcome).toMatchObject({ ok: false, status: 404, error: { type: "not_found" } });
      expect(runtime.mcpExecute).not.toHaveBeenCalled();
      expect(runtime.disposeMaterialized).toHaveBeenCalledOnce();
    });
  });

  it("reports an unavailable server instead of a missing tool", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-unavailable" }, async () => {
      runtime.diagnostics = [{ serverName: "granola", message: "connect failed" }];

      const outcome = await invoke("granola__list_meetings");

      expect(outcome).toMatchObject({
        ok: false,
        status: 500,
        error: {
          type: "tool_error",
          message: 'MCP server "granola" is unavailable: connect failed',
        },
      });
      expect(runtime.disposeMaterialized).toHaveBeenCalledOnce();
    });
  });

  it("retires the private runtime when acquisition fails", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-acquire-failure" }, async () => {
      runtime.materialize.mockRejectedValueOnce(new Error("catalog failed"));

      const outcome = await invoke("granola__list_meetings");

      expect(outcome).toMatchObject({
        ok: false,
        status: 500,
        error: { type: "tool_error", message: "MCP server unavailable" },
      });
      expect(runtime.retire).toHaveBeenCalledOnce();
    });
  });

  it.each(["session_status", "nope__list_meetings", "plain_plugin_tool"])(
    "does not connect MCP servers for %s",
    async (name) => {
      await withToolsInvokeTestState({ label: "mcp-invoke-unowned" }, async () => {
        await invoke(name);

        expect(runtime.acquire).not.toHaveBeenCalled();
      });
    },
  );
});
