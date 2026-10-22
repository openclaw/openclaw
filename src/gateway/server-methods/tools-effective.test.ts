import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { McpToolCatalog } from "../../agents/agent-bundle-mcp-types.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { EffectiveToolInventoryResult as ToolsEffectivePayload } from "../../agents/tools-effective-inventory.types.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { toolsEffectiveHandlers, testing } from "./tools-effective.js";

type InventoryModule = typeof import("../../agents/tools-effective-inventory.js");
type SessionLookup = typeof import("../session-utils.js").loadGatewaySessionEntryReadOnlyAsync;
type SessionMcpRuntimeView = Pick<
  NonNullable<
    ReturnType<typeof import("../../agents/agent-bundle-mcp-tools.js").peekSessionMcpRuntime>
  >,
  "configFingerprint" | "peekCatalog" | "workspaceDir"
>;
type SessionRead = Awaited<ReturnType<SessionLookup>>;

function makeSession(
  entry: Partial<NonNullable<SessionRead["entry"]>> = {},
  overrides: Partial<SessionRead> = {},
): SessionRead {
  const canonicalKey = overrides.canonicalKey ?? "main:abc";
  return {
    cfg: {},
    agentId: "main",
    storePath: "/tmp/sessions.json",
    store: {},
    canonicalKey,
    entry: { sessionId: "session-1", updatedAt: 1, ...entry },
    storeKeys: [canonicalKey],
    legacyKey: undefined,
    ...overrides,
  };
}

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
  applyFinalEffectiveToolPolicy: vi.fn<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js").applyFinalEffectiveToolPolicy
  >((params) => params.bundledTools),
  buildBundleMcpToolsFromCatalog: vi.fn<
    typeof import("../../agents/agent-bundle-mcp-tools.js").buildBundleMcpToolsFromCatalog
  >(() => []),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  getRegisteredAgentHarness: vi.fn(),
  resolveRuntimeConfigCacheKey: vi.fn(() => "runtime:1:test"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
  loadSessionEntry: vi.fn<
    (...args: Parameters<SessionLookup>) => Awaited<ReturnType<SessionLookup>>
  >(() => makeSession()),
  peekSessionMcpRuntime: vi.fn<() => SessionMcpRuntimeView | undefined>(() => undefined),
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:1:test",
    serverNames: [] as string[],
  })),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveEffectiveToolInventory: vi.fn(),
  resolveReplyToMode: vi.fn<
    typeof import("../../auto-reply/reply/reply-threading.js").resolveReplyToMode
  >(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
  getConnectedNodePluginToolsVersion: vi.fn(() => 1),
  acquireEffectiveToolInventoryRuntimeModelContext: vi.fn<
    InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]
  >(async () => ({
    run: (project) =>
      project({
        modelApi: "openai-responses",
        runtimeModel: makeProviderModelFixture({
          id: "gpt-4.1",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
      }),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  })),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-bundle-mcp-tools.js")>()),
  buildBundleMcpToolsFromCatalog: runtimeMocks.buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime: runtimeMocks.peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary: runtimeMocks.resolveSessionMcpConfigSummary,
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentDir: runtimeMocks.resolveAgentDir,
  resolveAgentWorkspaceDir: runtimeMocks.resolveAgentWorkspaceDir,
  resolveSessionAgentId: runtimeMocks.resolveSessionAgentId,
}));
vi.mock("../../agents/embedded-agent-runner/effective-tool-policy.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
  >()),
  applyFinalEffectiveToolPolicy: runtimeMocks.applyFinalEffectiveToolPolicy,
}));
vi.mock("../../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/registry.js")>()),
  getRegisteredAgentHarness: runtimeMocks.getRegisteredAgentHarness,
}));
vi.mock("../../agents/tools-effective-inventory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools-effective-inventory.js")>()),
  resolveEffectiveToolInventory: runtimeMocks.resolveEffectiveToolInventory,
  acquireEffectiveToolInventoryRuntimeModelContext:
    runtimeMocks.acquireEffectiveToolInventoryRuntimeModelContext,
}));
vi.mock("../../auto-reply/reply/reply-threading.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/reply-threading.js")>()),
  resolveReplyToMode: runtimeMocks.resolveReplyToMode,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  resolveRuntimeConfigCacheKey: runtimeMocks.resolveRuntimeConfigCacheKey,
}));
vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginChannelRegistryVersion: runtimeMocks.getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion: runtimeMocks.getActivePluginRegistryVersion,
}));
vi.mock("../../utils/delivery-context.read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/delivery-context.read.js")>()),
  deliveryContextFromSession: runtimeMocks.deliveryContextFromSession,
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  resolveSessionModelRef: runtimeMocks.resolveSessionModelRef,
}));
// mock-isolation: effective-tool policy tests supply session metadata without a database worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => runtimeMocks.loadSessionEntry(params.key, { agentId: params.agentId }),
}));
vi.mock("../node-plugin-tool-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-plugin-tool-snapshot.js")>()),
  getConnectedNodePluginToolsVersion: runtimeMocks.getConnectedNodePluginToolsVersion,
}));

const { applyFinalEffectiveToolPolicy } = await vi.importActual<
  typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
>("../../agents/embedded-agent-runner/effective-tool-policy.js");

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
async function invokeTools(
  params: Record<string, unknown> = { sessionKey: "main:abc" },
  cfg: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await expectDefined(
    toolsEffectiveHandlers["tools.effective"],
    "tools.effective handler",
  )({
    params,
    respond: respond as never,
    context: { getRuntimeConfig: () => cfg } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "tools.effective" },
    isWebchatConnect: () => false,
  });
  return respond;
}

function mockSession(
  entry: Partial<NonNullable<SessionRead["entry"]>>,
  overrides: Partial<SessionRead> = {},
) {
  runtimeMocks.loadSessionEntry.mockReturnValueOnce(makeSession(entry, overrides));
}

function resolveEffectiveToolInventoryArg(callIndex = 0): Record<string, unknown> | undefined {
  return runtimeMocks.resolveEffectiveToolInventory.mock.calls[callIndex]?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function payloadOf(respond: ReturnType<typeof vi.fn>) {
  return firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
}

function makeMcpTool(
  params: Record<string, unknown> = { type: "object", properties: {} },
  identity = {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    toolName: "probe_tool",
    serverName: "reproProbe",
    deniedBySession: false,
  },
) {
  const tool = {
    name: identity.name,
    label: identity.label,
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: identity.serverName,
      safeServerName: identity.serverName,
      toolName: identity.toolName,
      operation: "tool",
      ...(identity.deniedBySession ? { deniedBySession: true } : {}),
    },
  });
  return tool;
}

const coreTool = {
  id: "exec",
  label: "Exec",
  description: "Run shell commands",
  rawDescription: "Run shell commands",
  source: "core" as const,
};

function makeCoreInventory(tool: Partial<typeof coreTool> = {}): ToolsEffectivePayload {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [{ ...coreTool, ...tool }],
      },
    ],
  };
}

const makeMcpCatalog = () => ({ version: 1, generatedAt: 1, servers: {}, tools: [] });

function mockMcpConfigSummary(params: { fingerprint?: string; serverNames?: string[] } = {}): void {
  runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValueOnce({
    fingerprint: params.fingerprint ?? "mcp:1:test",
    serverNames: params.serverNames ?? ["reproProbe"],
  });
}

function mockWarmMcpRuntime(
  catalog: McpToolCatalog,
  params: { workspaceDir?: string; configFingerprint?: string } = {},
): void {
  runtimeMocks.peekSessionMcpRuntime.mockReturnValueOnce({
    workspaceDir: params.workspaceDir ?? "/tmp/workspace-main",
    configFingerprint: params.configFingerprint ?? "mcp:1:test",
    peekCatalog: () => catalog,
  });
}

function mockMcpTools(
  tools: ReturnType<typeof makeMcpTool>[],
  summary: Parameters<typeof mockMcpConfigSummary>[0] = {},
  catalog: McpToolCatalog = makeMcpCatalog(),
) {
  mockMcpConfigSummary(summary);
  mockWarmMcpRuntime(catalog);
  runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce(tools);
}

function expectInvalidResponse(respond: ReturnType<typeof vi.fn>, message: string): void {
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(message);
}

function expectPayloadGroupIds(
  respond: ReturnType<typeof vi.fn>,
  ids: string[],
  noticeId?: string,
): void {
  const payload = payloadOf(respond);
  expect(payload?.groups?.map((group) => group.id)).toEqual(ids);
  if (noticeId) {
    expect(payload.notices?.[0]?.id).toBe(noticeId);
  }
}

function expectResponsesOk(...responds: Array<ReturnType<typeof vi.fn>>): void {
  for (const respond of responds) {
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  }
}

describe("tools.effective handler", () => {
  afterEach(() => {
    memorySessionActorOwners.reset();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(runtimeMocks)) {
      mock.mockReset();
    }
    testing.resetToolsEffectiveCacheForTest();
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValue(makeCoreInventory());
  });

  it("rejects caller-supplied auth context params", async () => {
    expectInvalidResponse(
      await invokeTools({ sessionKey: "main:abc", senderIsOwner: true }),
      "invalid tools.effective params",
    );
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("uses memory session facts and refuses inventory after its captured owner closes", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/effective-tools");
    const sessionKey = "agent:main:dashboard:incognito-tools";
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    try {
      expect(
        (
          await actor.storage!.mutate(
            {
              type: "session.entry.create",
              input: { entry: { sessionId: "private-tools", updatedAt: 1, incognito: true } },
            },
            { assertCurrent() {}, authorize() {} },
          )
        ).kind,
      ).toBe("committed");
      const first = await invokeTools({ sessionKey });
      expect(firstRespondCall(first)?.[0]).toBe(true);
      expect(resolveEffectiveToolInventoryArg()?.sessionId).toBe("private-tools");
      expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
      testing.resetToolsEffectiveCacheForTest();
      runtimeMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
        memorySessionActorOwners.closeDatabase(owner);
        return makeCoreInventory();
      });
      const second = await invokeTools({ sessionKey });
      expect(firstRespondCall(second)?.[0]).toBe(false);
    } finally {
      await actor.release();
    }
  });

  it("rejects unknown session keys", async () => {
    mockSession({}, { canonicalKey: "missing-session", entry: undefined });
    const respond = await invokeTools({ sessionKey: "missing-session" });
    expectInvalidResponse(respond, 'unknown session key "missing-session"');
  });

  it.each([
    ["sessionId", "session-2"],
    ["spawnedWorkspaceDir", "/tmp/workspace-sandbox"],
  ] as const)("invalidates fresh inventory when %s changes", async (field, value) => {
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(makeCoreInventory({ id: "old_session_tool" }))
      .mockResolvedValueOnce(makeCoreInventory({ id: "new_session_tool" }));
    const first = await invokeTools();
    mockSession(field === "sessionId" ? { sessionId: value } : { spawnedWorkspaceDir: value });
    const second = await invokeTools();
    expect(payloadOf(first)).toMatchObject({ groups: [{ tools: [{ id: "old_session_tool" }] }] });
    expect(payloadOf(second)).toMatchObject({ groups: [{ tools: [{ id: "new_session_tool" }] }] });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    const inventoryField = field === "sessionId" ? "sessionId" : "workspaceDir";
    expect(resolveEffectiveToolInventoryArg(1)?.[inventoryField]).toBe(value);
  });

  it("updates returned web_search availability when only the saved override changes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => clock.mockRestore());
    const { resolveEffectiveToolInventory } = await vi.importActual<InventoryModule>(
      "../../agents/tools-effective-inventory.js",
    );
    runtimeMocks.resolveEffectiveToolInventory.mockImplementation(resolveEffectiveToolInventory);
    const cfg: OpenClawConfig = {
      tools: { web: { search: { enabled: true, provider: "brave" } } },
    };
    // Keep all other cache inputs and time fixed across both override transitions.
    for (const webSearch of [undefined, false, true, undefined]) {
      mockSession({ toolOverrides: { webSearch } }, { cfg });
      const respond = await invokeTools({ sessionKey: "main:abc" }, cfg);
      expectResponsesOk(respond);
      const payload = payloadOf(respond);
      const toolIds = payload.groups?.flatMap((group) => group.tools?.map((tool) => tool.id) ?? []);
      expect(toolIds?.includes("web_search")).toBe(webSearch !== false);
    }
  });

  it("coalesces identical base inventory cache misses while inventory resolution is pending", async () => {
    const [first, second] = await Promise.all([invokeTools(), invokeTools()]);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expectResponsesOk(first, second);
  });

  it("returns stale cached base inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    const stalePayload = makeCoreInventory({ id: "read" });
    const refreshedPayload = makeCoreInventory();
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(stalePayload)
      .mockResolvedValueOnce(refreshedPayload);

    await invokeTools();
    now += 11_000;

    const stale = await invokeTools();

    expect(firstRespondCall(stale)?.[1]).toBe(stalePayload);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = await invokeTools();
    expect(firstRespondCall(fresh)?.[1]).toBe(refreshedPayload);
  });

  it("reports configured MCP servers as not connected without starting them", async () => {
    mockMcpConfigSummary({ serverNames: ["zeta", "alpha"] });
    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"], "mcp-not-yet-connected");
    const notice = payloadOf(respond).notices?.[0];
    expect(notice?.message).toContain('"alpha", "zeta"');
    expect(notice?.servers).toEqual(["alpha", "zeta"]);
  });

  it("applies inherited MCP denies from the session entry already read by the request", async () => {
    const sessionKey = "agent:main:subagent:prepared-policy";
    const store = "/tmp/tools-effective-prepared-policy/sessions.sqlite";
    mockSession(
      {
        sessionId: "prepared-policy-session",
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["reproProbe__probe_tool"],
      },
      { cfg: { session: { store } }, storePath: store, canonicalKey: sessionKey },
    );
    mockMcpTools([makeMcpTool()]);
    runtimeMocks.applyFinalEffectiveToolPolicy.mockImplementationOnce(
      applyFinalEffectiveToolPolicy,
    );

    const respond = await invokeTools({ sessionKey });

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expectPayloadGroupIds(respond, ["core"]);
    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "uses only the native harness catalog (available: %s)",
    async (available) => {
      const toolOverrides = { mcpToolsDeny: { docs: ["delete"] } };
      mockSession({ agentHarnessId: "codex", toolOverrides });
      mockMcpConfigSummary();
      const catalog = makeMcpCatalog();
      const loadMcpToolCatalog = vi.fn().mockResolvedValue(available ? catalog : undefined);
      runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
        harness: { loadMcpToolCatalog },
      });
      runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([makeMcpTool()]);
      if (!available) {
        mockWarmMcpRuntime(makeMcpCatalog());
      }
      const respond = await invokeTools();
      expect(loadMcpToolCatalog).toHaveBeenCalledWith({
        config: {},
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "main:abc",
        workspaceDir: "/tmp/workspace-main",
        mcpServerNames: ["reproProbe"],
        toolOverrides,
      });
      if (available) {
        expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
          catalog,
          reservedToolNames: ["exec"],
          includeSessionDenied: true,
        });
        expectPayloadGroupIds(respond, ["core", "mcp"]);
      } else {
        expectPayloadGroupIds(respond, ["core"], "mcp-not-yet-connected");
      }
      expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
    },
  );

  it("preserves raw MCP identities and session denials across sanitized collisions", async () => {
    const enabled = makeMcpTool(undefined, {
      name: "collision__alpha-",
      label: "Alpha bang",
      toolName: "alpha!",
      serverName: "collision",
      deniedBySession: false,
    });
    const denied = makeMcpTool(undefined, {
      name: "collision__alpha--2",
      label: "Alpha question",
      toolName: "alpha?",
      serverName: "collision",
      deniedBySession: true,
    });
    mockMcpTools([enabled, denied], { serverNames: ["collision"] });
    const payload = payloadOf(await invokeTools());
    expect(payload?.groups?.[0]?.tools?.[0]).toEqual({
      id: "exec",
      label: "Exec",
      description: "Run shell commands",
      rawDescription: "Run shell commands",
      source: "core",
    });
    expect(payload?.groups?.[1]?.tools).toMatchObject([
      { id: "collision__alpha-", mcpServer: "collision", mcpToolName: "alpha!" },
      {
        id: "collision__alpha--2",
        mcpServer: "collision",
        mcpToolName: "alpha?",
        deniedBySession: true,
      },
    ]);
  });

  it("quarantines warm MCP tools with schemas the runtime cannot project", async () => {
    mockMcpTools([makeMcpTool({ type: "array", items: { type: "string" } })]);

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"], "unsupported-tool-schema:reproProbe__probe_tool");
  });

  it.each(["empty", "mixed"])(
    "reports unavailable MCP servers with a %s catalog without losing base notices",
    async (kind) => {
      const baseNotice = { id: "base-notice", severity: "info", message: "Keep the base notice" };
      const base = { ...makeCoreInventory(), notices: [baseNotice] };
      const diagnostic = {
        serverName: "offline",
        safeServerName: "offline",
        launchSummary: "https://mcp.example.invalid/mcp",
        message:
          "unavailable; retry after 2026-09-25T12:00:30.000Z; check reachability or reload MCP",
      };
      runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(base);
      mockMcpTools(
        kind === "empty" ? [] : [makeMcpTool()],
        { serverNames: ["offline", "reproProbe"] },
        { ...makeMcpCatalog(), diagnostics: [diagnostic] },
      );

      const respond = await invokeTools();

      expectPayloadGroupIds(respond, kind === "empty" ? ["core"] : ["core", "mcp"]);
      const payload = payloadOf(respond);
      expect(payload.notices).toEqual([
        baseNotice,
        {
          id: "mcp-server-diagnostic:offline",
          severity: "warning",
          message: `MCP server "offline": ${diagnostic.message}`,
          servers: ["offline"],
        },
      ]);
      expect(base.notices).toEqual([baseNotice]);
    },
  );

  it("keeps usable MCP tools and ordered quarantine notices without changing the cached base", async () => {
    const base = {
      ...makeCoreInventory(),
      notices: [{ id: "base-notice", severity: "info", message: "Keep the base notice" }],
    };
    const originalBase = structuredClone(base);
    Object.freeze(base.groups);
    Object.freeze(base.notices);
    Object.freeze(base);
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(base);
    const invalid = makeMcpTool({ type: "array", items: { type: "string" } });
    invalid.name = "reproProbe__invalid";
    mockMcpTools([makeMcpTool(), invalid]);

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core", "mcp"]);
    const payload = payloadOf(respond);
    expect(payload.groups?.[1]?.tools?.map((tool) => tool.id)).toEqual(["reproProbe__probe_tool"]);
    expect(payload.notices?.map((notice) => notice.id)).toEqual([
      "base-notice",
      "unsupported-tool-schema:reproProbe__invalid",
    ]);
    expect(base).toEqual(originalBase);
  });

  it("does not project stale MCP catalogs after config changes", async () => {
    mockMcpConfigSummary({ fingerprint: "mcp:2:test" });
    mockWarmMcpRuntime(makeMcpCatalog(), { configFingerprint: "mcp:1:test" });

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"], "mcp-stale-catalog");
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).not.toHaveBeenCalled();
  });

  it("rejects unknown agent ids before loading the session", async () => {
    const respond = await invokeTools({ sessionKey: "main:abc", agentId: "other" });
    expectInvalidResponse(respond, 'unknown agent id "other"');
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("loads a bare session through the persisted fixed-store owner", async () => {
    const cfg: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    const entry = { sessionId: "session-ops-global", updatedAt: 1 };
    mockSession(entry, {
      cfg,
      agentId: "ops",
      canonicalKey: "global",
      store: { global: entry },
      storePath: "/tmp/shared-sessions.sqlite",
    });
    runtimeMocks.resolveSessionAgentId.mockReturnValue("ops");

    const respond = await invokeTools({ sessionKey: "global" }, cfg);

    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(resolveEffectiveToolInventoryArg()?.agentId).toBe("ops");
  });
});
