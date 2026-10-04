// Warm managed MCP invoke tests cover Gateway policy, stale catalogs, and live
// re-admission after before_tool_call over HTTP and RPC with lightweight mocks.
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { runBeforeToolCallHook as runBeforeToolCallHookType } from "../agents/agent-tools.before-tool-call.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createToolsInvokeHttpTestServer } from "./tools-invoke-http.test-support.js";

type RunBeforeToolCallHook = typeof runBeforeToolCallHookType;
type RunBeforeToolCallHookArgs = Parameters<RunBeforeToolCallHook>[0];
type RunBeforeToolCallHookResult = Awaited<ReturnType<RunBeforeToolCallHook>>;

const hookMocks = vi.hoisted(() => ({
  runBeforeToolCallHook: vi.fn(
    async (args: RunBeforeToolCallHookArgs): Promise<RunBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
}));
const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const mcpMocks = vi.hoisted(() => ({
  peekSessionMcpRuntime: vi.fn(),
  resolveSessionMcpConfigSummary: vi.fn(),
  buildBundleMcpToolsFromCatalog: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
}));

let cfg: Record<string, unknown> = {};

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  loadExactSessionEntryReadOnly: (params: { sessionKey: string }) => {
    const entry = sessionEntries.get(params.sessionKey);
    return entry ? { sessionKey: params.sessionKey, entry } : undefined;
  },
  loadExactSessionEntryCandidates: (params: { sessionKeys: readonly string[] }) =>
    params.sessionKeys.flatMap((sessionKey) => {
      const entry = sessionEntries.get(sessionKey);
      return entry ? [{ sessionKey, entry }] : [];
    }),
  resolveSessionEntryAccessTarget: (params: { sessionKey: string }) => ({
    entry: sessionEntries.get(params.sessionKey),
  }),
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-tools.js")>()),
  ...mcpMocks,
}));

// Managed MCP tools arrive as additional tools; the core factory stays empty.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => [],
}));

vi.mock("../agents/agent-tools.js", () => ({
  resolveToolLoopDetectionConfig: () => ({ warnAt: 3 }),
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");
const { toolsInvokeHandlers } = await import("./server-methods/tools-invoke.js");

const server = createToolsInvokeHttpTestServer({
  handleToolsInvoke: handleToolsInvokeHttpRequest,
});
let port = 0;

beforeAll(async () => {
  port = await server.listen();
});

afterAll(() => server.close());

beforeEach(() => {
  cfg = {};
  server.resetContext();
  sessionEntries.clear();
  mcpMocks.peekSessionMcpRuntime.mockReset();
  mcpMocks.resolveSessionMcpConfigSummary.mockReset();
  mcpMocks.buildBundleMcpToolsFromCatalog.mockReset();
  mcpMocks.materializeBundleMcpToolsForRun.mockReset();
  hookMocks.runBeforeToolCallHook.mockClear();
});

const name = "icecouncil__icecouncil_status";

const createMcpTool = () => {
  const mcpTool = {
    name,
    label: name,
    description: "Read containment status",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "contained" }],
      details: {},
    })),
  };
  setPluginToolMeta(mcpTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "icecouncil",
      safeServerName: "icecouncil",
      toolName: "icecouncil_status",
      operation: "tool",
    },
  });
  return mcpTool;
};

const warmRuntime = (configFingerprint: string, extra: Record<string, unknown> = {}) => ({
  configFingerprint,
  workspaceDir: "/tmp/workspace",
  peekCatalog: () => ({ tools: [], servers: {} }),
  ...extra,
});

const setMainAllowedTools = (params: { allow: string[]; gatewayDeny?: string[] }) => {
  cfg = {
    agents: { list: [{ id: "main", default: true, tools: { allow: params.allow } }] },
    ...(params.gatewayDeny ? { gateway: { tools: { deny: params.gatewayDeny } } } : {}),
  };
};

const invokeHttp = async () =>
  await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openclaw-scopes": "operator.write" },
    body: JSON.stringify({ tool: name, args: {}, sessionKey: "main" }),
  });

const invokeRpc = async () => {
  const respond = vi.fn();
  await expectDefined(
    toolsInvokeHandlers["tools.invoke"],
    'toolsInvokeHandlers["tools.invoke"] test invariant',
  )({
    params: { name, args: {}, sessionKey: "main" },
    respond,
    context: { getRuntimeConfig: () => cfg } as never,
    client: { connect: { role: "operator", scopes: ["operator.write"] } } as never,
    req: { type: "req", id: "req-rpc-1", method: "tools.invoke" },
    isWebchatConnect: () => false,
  });
  const payload = respond.mock.calls[0]?.[1] as { error?: { code?: string } } | undefined;
  return payload?.error?.code;
};

describe("warm managed MCP tools via /tools/invoke and tools.invoke", () => {
  it("invokes a warm managed MCP tool through Gateway policy and hooks", async () => {
    const mcpTool = createMcpTool();
    const dispose = vi.fn(async () => {});
    setMainAllowedTools({ allow: [name] });
    sessionEntries.set("agent:main:main", { sessionId: "warm-session" });
    mcpMocks.peekSessionMcpRuntime.mockReturnValue(warmRuntime("current"));
    mcpMocks.resolveSessionMcpConfigSummary.mockReturnValue({ fingerprint: "current" });
    mcpMocks.buildBundleMcpToolsFromCatalog.mockReturnValue([mcpTool]);
    mcpMocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools: [mcpTool], dispose });

    const res = await invokeHttp();

    expect(res.status).toBe(200);
    expect(mcpTool.execute).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(hookMocks.runBeforeToolCallHook.mock.calls[0]?.[0].toolName).toBe(name);
  });

  it("keeps stale and policy-denied managed MCP tools unavailable", async () => {
    const mcpTool = createMcpTool();
    sessionEntries.set("agent:main:main", { sessionId: "warm-session" });
    mcpMocks.peekSessionMcpRuntime.mockReturnValue(warmRuntime("old"));
    mcpMocks.resolveSessionMcpConfigSummary.mockReturnValue({ fingerprint: "current" });
    mcpMocks.buildBundleMcpToolsFromCatalog.mockReturnValue([mcpTool]);
    mcpMocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [mcpTool],
      dispose: vi.fn(async () => {}),
    });
    setMainAllowedTools({ allow: [name] });
    expect((await invokeHttp()).status).toBe(404);
    expect(mcpMocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();

    mcpMocks.peekSessionMcpRuntime.mockReturnValue(warmRuntime("current"));
    setMainAllowedTools({ allow: [name], gatewayDeny: [name] });
    expect((await invokeHttp()).status).toBe(404);
    expect(mcpTool.execute).not.toHaveBeenCalled();
    expect(mcpMocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();

    setMainAllowedTools({ allow: [name] });
    mcpMocks.peekSessionMcpRuntime.mockReturnValue(
      warmRuntime("current", { isRequesterScopedServer: () => true }),
    );
    expect((await invokeHttp()).status).toBe(404);
    expect(mcpMocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();
  });

  it("re-admits a warm managed MCP tool after before_tool_call", async () => {
    const mcpTool = createMcpTool();
    mcpMocks.peekSessionMcpRuntime.mockReturnValue(warmRuntime("current"));
    mcpMocks.resolveSessionMcpConfigSummary.mockImplementation(
      (params: { toolOverrides?: { mcpToolsDeny?: unknown } }) => ({
        fingerprint: params.toolOverrides?.mcpToolsDeny ? "session-deny" : "current",
      }),
    );
    mcpMocks.buildBundleMcpToolsFromCatalog.mockReturnValue([mcpTool]);
    mcpMocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [mcpTool],
      dispose: vi.fn(async () => {}),
    });
    const changeWhileHookRuns = (change: () => void) =>
      hookMocks.runBeforeToolCallHook.mockImplementationOnce(async (args) => {
        change();
        return { blocked: false, params: args.params };
      });
    setMainAllowedTools({ allow: [name] });
    sessionEntries.set("agent:main:main", { sessionId: "warm-session" });

    changeWhileHookRuns(() => setMainAllowedTools({ allow: [name], gatewayDeny: [name] }));
    expect((await invokeHttp()).status).toBe(404);
    expect(hookMocks.runBeforeToolCallHook).toHaveBeenCalledTimes(1);

    setMainAllowedTools({ allow: [name] });
    changeWhileHookRuns(() =>
      sessionEntries.set("agent:main:main", {
        sessionId: "warm-session",
        toolOverrides: { mcpToolsDeny: { icecouncil: ["icecouncil_status"] } },
      }),
    );
    expect(await invokeRpc()).toBe("not_found");
    expect(hookMocks.runBeforeToolCallHook).toHaveBeenCalledTimes(2);
    expect(mcpTool.execute).not.toHaveBeenCalled();

    sessionEntries.set("agent:main:main", { sessionId: "warm-session" });
    changeWhileHookRuns(() => {
      cfg = { ...cfg, logging: { level: "debug" } };
    });
    expect((await invokeHttp()).status).toBe(200);
    expect(mcpTool.execute).toHaveBeenCalledOnce();
  });
});
