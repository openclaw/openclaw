import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSessionMcpCallerAuthority } from "../agents/agent-bundle-mcp-request-context.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
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
  pluginToolNames: [] as string[],
}));

// mock-isolation: Each case supplies its own runtime config without touching disk state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
// mock-isolation: Same isolated config for readers that import the IO owner directly.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
// Like the real factory, a nonempty explicit allowlist loads only plugins owning those tools.
// mock-isolation: Core and plugin tools stay inert; an empty allowlist loads every plugin.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async (options?: { pluginToolAllowlist?: string[] }) => [
    { name: "session_status", parameters: { type: "object" }, execute: runtime.coreExecute },
    ...runtime.pluginToolNames
      .filter((name) => {
        const allowlist = options?.pluginToolAllowlist ?? [];
        return allowlist.length === 0 || allowlist.includes(name);
      })
      .map((name) => {
        const tool = { name, parameters: { type: "object" }, execute: runtime.coreExecute };
        setPluginToolMeta(tool as unknown as AnyAgentTool, {
          pluginId: "collide",
          optional: false,
        });
        return tool;
      }),
  ],
}));
// mock-isolation: Tool construction helpers stay inert outside the invocation path.
vi.mock("../agents/agent-tools.js", () => ({ resolveToolLoopDetectionConfig: () => ({}) }));
// mock-isolation: Hooks pass arguments through so policy, not hooks, decides each case.
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
function createMcpTool(toolName: string, name = `granola__${toolName}`): AnyAgentTool {
  const tool = {
    name,
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

const sessionKey = "agent:main:dashboard:mcp-overrides";

const invoke = (name: string, options: { sessionKey?: string; signal?: AbortSignal } = {}) =>
  invokeGatewayTool({
    cfg: runtime.cfg,
    input: { name, args: { limit: 3 }, ...(options.sessionKey ? { sessionKey } : {}) },
    senderIsOwner: true,
    toolCallIdPrefix: "rpc",
    signal: options.signal,
  });

const storeOverrides = async (toolOverrides: SessionToolOverrides | undefined) =>
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId: "mcp-overrides", updatedAt: Date.now(), toolOverrides },
  );

beforeEach(() => {
  vi.clearAllMocks();
  runtime.diagnostics = undefined;
  runtime.pluginToolNames = [];
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

  it("invokes the suffixed name discovery advertises for a plugin-tool collision", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-collision" }, async () => {
      runtime.pluginToolNames = ["granola__list_meetings"];
      runtime.materialize.mockImplementationOnce(
        async ({ reservedToolNames }: { reservedToolNames: readonly string[] }) => ({
          tools: [
            createMcpTool(
              "list_meetings",
              reservedToolNames.includes("granola__list_meetings")
                ? "granola__list_meetings-2"
                : "granola__list_meetings",
            ),
          ],
          dispose: runtime.disposeMaterialized,
        }),
      );

      const outcome = await invoke("granola__list_meetings-2");

      expect(outcome).toMatchObject({ ok: true, source: "mcp" });
      expect(runtime.mcpExecute).toHaveBeenCalledOnce();
      expect(runtime.coreExecute).not.toHaveBeenCalled();
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

describe("tools.invoke configured MCP session policy", () => {
  it("does not connect a server the session disabled", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-session-disabled" }, async () => {
      await storeOverrides({ mcpServers: { granola: false } });

      const outcome = await invoke("granola__list_meetings", { sessionKey });

      expect(outcome).toMatchObject({ ok: false, status: 404, error: { type: "not_found" } });
      expect(runtime.acquire).not.toHaveBeenCalled();
    });
  });

  it("refuses with 403 when caller authority is revoked during discovery", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-revoked-discovery" }, async () => {
      let revoked = false;
      runtime.materialize.mockImplementationOnce(async () => {
        revoked = true;
        return { tools: [createMcpTool("list_meetings")], dispose: runtime.disposeMaterialized };
      });

      const outcome = await invokeGatewayTool({
        cfg: runtime.cfg,
        input: { name: "granola__list_meetings" },
        senderIsOwner: true,
        toolCallIdPrefix: "http",
        assertInvocationCurrent: () => {
          if (revoked) {
            throw Object.assign(new Error("Gateway requester authority changed"), {
              name: "ToolAuthorizationError",
              status: 403,
            });
          }
        },
      });

      expect(outcome).toMatchObject({
        ok: false,
        status: 403,
        error: { type: "tool_call_blocked" },
      });
      expect(runtime.mcpExecute).not.toHaveBeenCalled();
      expect(runtime.disposeMaterialized).toHaveBeenCalledOnce();
    });
  });

  it("refuses server I/O after the session's MCP policy changes mid-call", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-session-change" }, async () => {
      await storeOverrides(undefined);
      const serverRequest = vi.fn(async () => ({ content: [] }));
      runtime.mcpExecute.mockImplementationOnce(async () => {
        // The policy changes while the runtime waits for its connection or catalog.
        await storeOverrides({ mcpServers: { granola: false } });
        return await withSessionMcpCallerAuthority(serverRequest)();
      });

      const outcome = await invoke("granola__list_meetings", { sessionKey });

      expect(outcome).toMatchObject({ ok: false, status: 403 });
      expect(serverRequest).not.toHaveBeenCalled();
    });
  });

  it("retires the runtime when the request is canceled during discovery", async () => {
    await withToolsInvokeTestState({ label: "mcp-invoke-cancel" }, async () => {
      const controller = new AbortController();
      let failDiscovery: (error: Error) => void = () => undefined;
      runtime.materialize.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failDiscovery = reject;
            controller.abort(new Error("client disconnected"));
          }),
      );
      // Retirement closes the transport, which fails the pending tools/list.
      runtime.retire.mockImplementationOnce(async () => {
        failDiscovery(new Error("connection closed"));
        return true;
      });

      await expect(invoke("granola__list_meetings", { signal: controller.signal })).rejects.toThrow(
        "client disconnected",
      );
      expect(runtime.retire).toHaveBeenCalledOnce();
      expect(runtime.mcpExecute).not.toHaveBeenCalled();
    });
  });
});
