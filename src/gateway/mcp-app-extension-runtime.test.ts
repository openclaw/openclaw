import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCatalogTool } from "../agents/agent-bundle-mcp-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { prepareMcpAppExtensionRuntime } from "./mcp-app-extension-runtime.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  direct: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  source: vi.fn(),
  releaseSource: vi.fn(),
  registered: vi.fn(),
  assert: vi.fn(),
  selection: vi.fn(),
  retain: vi.fn(),
  releaseAccess: vi.fn(),
  catalog: vi.fn(),
  project: vi.fn(),
  metadata: vi.fn(),
  approval: vi.fn(),
}));
vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  acquireSessionMcpRuntime: mocks.direct,
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  releaseSessionMcpRuntime: vi.fn(),
}));
// mock-isolation: Exercise App approval routing without materializing plugin runtimes.
vi.mock("../agents/agent-bundle-mcp-materialize.js", () => ({
  buildBundleMcpToolsFromCatalog: mocks.project,
}));
vi.mock("../agents/agent-bundle-mcp-runtime-config.js", () => ({
  loadSessionMcpConfig: () => ({ loaded: { mcpServers: {} } }),
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir: () => "/agent",
  resolveAgentWorkspaceDir: () => "/workspace",
}));
vi.mock("../agents/harness/registry.js", () => ({ getRegisteredAgentHarness: mocks.registered }));
vi.mock("../agents/thinking-runtime.js", () => ({ resolveEffectiveAgentRuntime: mocks.selection }));
vi.mock("../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
}));
vi.mock("../agents/harness/session-preparation.js", () => ({
  prepareAgentHarnessSessionRuntime: mocks.prepare,
}));
// mock-isolation: The fixture catalog supplies its own projected tool identity.
vi.mock("../plugins/tool-metadata.js", () => ({ getPluginToolMeta: mocks.metadata }));
vi.mock("./mcp-app-host-files.js", () => ({ resolveMcpAppRequesterId: () => "alice" }));
// mock-isolation: Approval delivery is external to the runtime owner's authority checks.
vi.mock("./mcp-app-tool-approval.js", () => ({ requestMcpAppToolApproval: mocks.approval }));
vi.mock("./operator-run-authority.js", () => ({
  captureGatewayOperatorRunAuthority: mocks.source,
}));
vi.mock("./session-resource-tool-policy.js", () => ({ resolveSessionResourceToolPolicy: vi.fn() }));
vi.mock("./session-row-projection-access.js", () => ({
  getSessionRowProjection: () => ({ sharingTarget: () => ({ entry, storePath: "/store" }) }),
}));
// mock-isolation: App admission uses fixture model selection without native session ownership reads.
vi.mock("./session-utils-model-selection.js", () => ({
  resolveSessionSelectedModelRefAsync: async () => ({ provider: "openai", model: "model" }),
}));
const config = { mcp: { apps: { enabled: true } } };
let entry: { sessionId: string } & Partial<SessionEntry>;
let accessController: AbortController;
function options() {
  return {
    context: { getRuntimeConfig: () => config },
    sessionAccessAuthority: {
      assertCurrent: mocks.assert,
      retain: mocks.retain,
      target: { agentId: "main", sessionKey: "agent:main:app", sessionId: "session" },
    },
  } as unknown as GatewayRequestHandlerOptions;
}
beforeEach(() => {
  vi.resetAllMocks();
  entry = { sessionId: "session", agentRuntimeOverride: "codex" };
  accessController = new AbortController();
  mocks.retain.mockImplementation(() => ({
    signal: accessController.signal,
    assertCurrent: () => accessController.signal.throwIfAborted(),
    release: mocks.releaseAccess,
  }));
  mocks.releaseAccess.mockImplementation(() => accessController.abort(new Error("released")));
  mocks.project.mockReturnValue([]);
  mocks.catalog.mockResolvedValue({ version: 1, generatedAt: 1, servers: {}, tools: [] });
  mocks.selection.mockReturnValue("codex");
  mocks.registered.mockReturnValue({
    ownerPluginId: "codex",
    harness: { loadMcpToolCatalog: vi.fn(), acquireMcpAppRuntime: mocks.native },
  });
  mocks.source.mockResolvedValue({ authority: { kind: "fixture" }, release: mocks.releaseSource });
  mocks.prepare.mockResolvedValue({
    preparation: { version: 1, purpose: "mcp-app" },
    dispose: mocks.dispose,
  });
  mocks.native.mockImplementation(async ({ prepareSession }) => {
    await prepareSession();
    return {
      runtime: {
        getCatalog: mocks.catalog,
        assertOwnerCurrent: mocks.assert,
        joinCleanup: async () => {},
      },
      releaseLease: vi.fn(),
    };
  });
});
describe("cold App request admission", () => {
  it.each(["launch", "view"])("keeps live authority through %s tool approval", async (kind) => {
    const tool: McpCatalogTool = {
      serverName: "demo",
      safeServerName: "demo",
      toolName: "show",
      inputSchema: Type.Object({}),
      fallbackDescription: "Show an App",
    };
    mocks.catalog.mockResolvedValue({
      version: 1,
      generatedAt: 1,
      servers: { demo: { pluginId: "demo" } },
      tools: [tool],
    });
    mocks.project.mockReturnValue([{ name: "demo_show" }]);
    mocks.metadata.mockReturnValue({ mcp: { operation: "tool", ...tool } });
    const active = await prepareMcpAppExtensionRuntime(options());
    accessController = new AbortController();
    const view = active.retainViewAuthority([tool]);
    const input = { city: "Paris" };
    const assertion =
      kind === "launch"
        ? await active.approveTool(tool, input)
        : await view.prepareToolCall({
            options: options(),
            toolName: tool.toolName,
            input,
            assertCurrent: mocks.assert,
          });
    expect(mocks.approval).toHaveBeenCalledOnce();
    expect(mocks.approval.mock.lastCall?.[0]).toMatchObject({
      serverName: "demo",
      toolName: "show",
      input,
    });
    expect(assertion).toBeTypeOf("function");
    expect(() => assertion?.()).not.toThrow();
    accessController.abort(new Error("revoked"));
    expect(() => assertion?.()).toThrow("revoked");
    view.release();
    await active.dispose();
  });
  it("selects the current harness before any historical model turn and admits its native setup", async () => {
    const active = await prepareMcpAppExtensionRuntime(options());
    expect(mocks.selection.mock.lastCall?.[0]).toMatchObject({ sessionEntry: entry });
    expect(mocks.prepare.mock.lastCall?.[0]).toMatchObject({
      ownerPluginId: "codex",
      sourceAuthority: { kind: "fixture" },
      input: {
        senderId: "alice",
        sessionId: "session",
        workspaceDir: "/workspace",
        abortSignal: accessController.signal,
      },
    });
    expect(mocks.native.mock.lastCall?.[0]).toMatchObject({
      appRequester: { kind: "gateway-profile", profileId: "alice" },
    });
    expect(mocks.direct).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.releaseSource).toHaveBeenCalledOnce();
    expect(mocks.retain).toHaveBeenCalledOnce();
    expect(mocks.releaseAccess).toHaveBeenCalledOnce();
    expect(accessController.signal.aborted).toBe(true);
    await active.dispose();
  });
  it.each(["caller", "access"])("cancels native setup when %s authority aborts", async (source) => {
    const caller = new AbortController();
    const request = options();
    request.signal = caller.signal;
    mocks.prepare.mockImplementation(async ({ input }) => {
      (source === "caller" ? caller : accessController).abort(new Error("revoked"));
      input.abortSignal.throwIfAborted();
    });
    await expect(prepareMcpAppExtensionRuntime(request)).rejects.toThrow("revoked");
    expect(mocks.releaseAccess).toHaveBeenCalledOnce();
    expect(mocks.releaseSource).toHaveBeenCalledOnce();
  });
  it("does not prepare credentials after source authority disappears", async () => {
    mocks.source.mockImplementation(async () => {
      mocks.assert.mockImplementation(() => {
        throw new Error("revoked");
      });
      return { release: mocks.releaseSource };
    });
    await expect(prepareMcpAppExtensionRuntime(options())).rejects.toThrow("revoked");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.releaseSource).toHaveBeenCalledOnce();
  });
  it("keeps a retained App valid after ordinary turn observations", async () => {
    const active = await prepareMcpAppExtensionRuntime(options());
    // Use a fresh view borrow, independent of the completed setup lifetime.
    accessController = new AbortController();
    const view = active.retainViewAuthority([]);
    entry = { ...entry, agentHarnessId: "previous-harness" };
    expect(active.assertCurrent).not.toThrow();
    expect(view.assertCurrent).not.toThrow();
    expect(mocks.native).toHaveBeenCalledOnce();
    view.release();
    await active.dispose();
  });
  it.each([{ authProfileOverride: "other-profile" }, { sandboxMode: "off" as const }])(
    "continues to revoke changed authority %j",
    async (change) => {
      const active = await prepareMcpAppExtensionRuntime(options());
      entry = { ...entry, ...change };
      expect(active.assertCurrent).toThrow("runtime selection changed");
      await active.dispose();
    },
  );
  it.each([
    { harness: undefined, error: "harness is unavailable" },
    {
      harness: { acquireMcpAppRuntime: mocks.native },
      error: "session harness cannot open MCP Apps",
    },
    { harness: { loadMcpToolCatalog: vi.fn() }, error: "session harness cannot open MCP Apps" },
  ])(
    "rejects incomplete native harness %j without replacing its transport",
    async ({ harness, error }) => {
      mocks.registered.mockReturnValue(harness && { ownerPluginId: "codex", harness });
      await expect(prepareMcpAppExtensionRuntime(options())).rejects.toThrow(error);
      expect(mocks.direct).not.toHaveBeenCalled();
      expect(mocks.native).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );
});
