// Effective tools tests cover session-scoped tool inventory, MCP catalog state,
// caching behavior, delivery context, and policy filtering.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { McpToolCatalog } from "../../agents/agent-bundle-mcp-types.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { toolsEffectiveHandlers, testing } from "./tools-effective.js";

type InventoryModule = typeof import("../../agents/tools-effective-inventory.js");
type SessionMcpRuntimeView = Pick<
  NonNullable<
    ReturnType<typeof import("../../agents/agent-bundle-mcp-tools.js").peekSessionMcpRuntime>
  >,
  "configFingerprint" | "peekCatalog" | "workspaceDir"
>;
type AcquiredRuntimeModelContext = Awaited<
  ReturnType<InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]>
>;
type RuntimeModelContext = Parameters<Parameters<AcquiredRuntimeModelContext["run"]>[0]>[0];

function createAcquiredRuntimeModelContext(
  context: RuntimeModelContext,
): AcquiredRuntimeModelContext {
  return { run: (project) => project(context), [Symbol.asyncDispose]: vi.fn(async () => {}) };
}

const resolveEffectiveToolInventoryRuntimeModelContextMock = vi.hoisted(() =>
  vi.fn((_params?: unknown): RuntimeModelContext => ({
    modelApi: "openai-responses",
    runtimeModel: makeProviderModelFixture({
      id: "gpt-4.1",
      name: "GPT 4.1",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
  })),
);

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
  getRuntimeConfig: vi.fn(() => ({})),
  loadSessionEntry: vi.fn<typeof import("../session-utils.js").loadGatewaySessionEntryReadOnly>(
    () => ({
      cfg: {},
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastAccountId: "acct-1",
        lastThreadId: "thread-2",
        lastTo: "channel-1",
        groupId: "group-4",
        groupChannel: "#ops",
        space: "workspace-5",
        chatType: "group",
        modelProvider: "openai",
        model: "gpt-4.1",
        spawnedBy: "agent:main:telegram:group:parent-group",
        spawnedWorkspaceDir: undefined as string | undefined,
      },
      storeKeys: ["main:abc"],
      legacyKey: undefined,
    }),
  ),
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
  resolveEffectiveToolInventoryRuntimeModelContext:
    resolveEffectiveToolInventoryRuntimeModelContextMock,
  acquireEffectiveToolInventoryRuntimeModelContext: vi.fn<
    InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]
  >(async (params) =>
    createAcquiredRuntimeModelContext(resolveEffectiveToolInventoryRuntimeModelContextMock(params)),
  ),
}));

const nodePluginToolSnapshotMocks = vi.hoisted(() => ({
  version: 1,
  getConnectedNodePluginToolsVersion: vi.fn(() => nodePluginToolSnapshotMocks.version),
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
  loadGatewaySessionEntryReadOnly: runtimeMocks.loadSessionEntry,
  resolveSessionModelRef: runtimeMocks.resolveSessionModelRef,
}));
vi.mock("../node-plugin-tool-snapshot.js", () => nodePluginToolSnapshotMocks);

const { applyFinalEffectiveToolPolicy } = await vi.importActual<
  typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
>("../../agents/embedded-agent-runner/effective-tool-policy.js");

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type ToolsEffectivePayload = {
  agentId?: string;
  profile?: string;
  notices?: Array<{ id?: string; severity?: string; message?: string; servers?: string[] }>;
  groups?: Array<{
    id?: string;
    label?: string;
    source?: string;
    tools?: Array<{
      id?: string;
      label?: string;
      description?: string;
      rawDescription?: string;
      source?: string;
      pluginId?: string;
      mcpServer?: string;
      mcpToolName?: string;
      deniedBySession?: true;
    }>;
  }>;
};

function createInvokeParams(params: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        toolsEffectiveHandlers["tools.effective"],
        'toolsEffectiveHandlers["tools.effective"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => cfg } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

function resolveEffectiveToolInventoryArg(callIndex = 0): Record<string, unknown> | undefined {
  const calls = runtimeMocks.resolveEffectiveToolInventory.mock.calls as unknown as Array<
    [Record<string, unknown>]
  >;
  return calls[callIndex]?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function makeMcpTool(params: Record<string, unknown> = { type: "object", properties: {} }) {
  const tool = {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "reproProbe",
      safeServerName: "reproProbe",
      toolName: "probe_tool",
      operation: "tool",
    },
  });
  return tool;
}

function makeCoreInventory(
  tool: { id: string; label: string; description: string; rawDescription?: string } = {
    id: "exec",
    label: "Exec",
    description: "Run shell commands",
  },
): ToolsEffectivePayload {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: tool.id,
            label: tool.label,
            description: tool.description,
            rawDescription: tool.rawDescription ?? tool.description,
            source: "core",
          },
        ],
      },
    ],
  };
}

function makeMcpCatalog(): McpToolCatalog {
  return { version: 1, generatedAt: 1, servers: {}, tools: [] };
}

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

function mockWarmMcpTool(params: Record<string, unknown> = { type: "object", properties: {} }) {
  const mcpTool = makeMcpTool(params);
  const catalog = makeMcpCatalog();
  mockMcpConfigSummary();
  mockWarmMcpRuntime(catalog);
  runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([mcpTool]);
  return { catalog, mcpTool };
}

function expectInvalidResponse(respond: ReturnType<typeof vi.fn>, message: string): void {
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(message);
}

async function expectInvalidToolsParams(
  params: Record<string, unknown>,
  message: string,
): Promise<void> {
  const { respond, invoke } = createInvokeParams(params);
  await invoke();
  expectInvalidResponse(respond, message);
}

function expectPayloadGroupIds(respond: ReturnType<typeof vi.fn>, ids: string[]): void {
  const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
  expect(payload?.groups?.map((group) => group.id)).toEqual(ids);
}

function expectResponsesOk(...responds: Array<ReturnType<typeof vi.fn>>): void {
  for (const respond of responds) {
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  }
}

function expectPayloadNotice(respond: ReturnType<typeof vi.fn>, id: string) {
  const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
  const notice = payload?.notices?.[0];
  expect(notice?.id).toBe(id);
  return notice;
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
    testing.setToolsEffectiveNowForTest();
    nodePluginToolSnapshotMocks.version = 1;
    runtimeMocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace-main");
    runtimeMocks.resolveAgentDir.mockReturnValue("/tmp/agents/main/agent");
    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
    runtimeMocks.getActivePluginRegistryVersion.mockReturnValue(1);
    runtimeMocks.resolveRuntimeConfigCacheKey.mockReturnValue("runtime:1:test");
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext.mockReturnValue({
      modelApi: "openai-responses",
      runtimeModel: makeProviderModelFixture({
        id: "gpt-4.1",
        name: "GPT 4.1",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
    });
    runtimeMocks.acquireEffectiveToolInventoryRuntimeModelContext
      .mockReset()
      .mockImplementation(async (params) =>
        createAcquiredRuntimeModelContext(
          resolveEffectiveToolInventoryRuntimeModelContextMock(params),
        ),
      );
    runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
      fingerprint: "mcp:1:test",
      serverNames: [] as string[],
    });
    runtimeMocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValue(undefined);
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValue([]);
    runtimeMocks.applyFinalEffectiveToolPolicy.mockImplementation((params) => params.bundledTools);
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValue(makeCoreInventory());
  });

  it("rejects caller-supplied auth context params", async () => {
    await expectInvalidToolsParams(
      { sessionKey: "main:abc", senderIsOwner: true },
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
      const first = createInvokeParams({ sessionKey });
      await first.invoke();
      expect(firstRespondCall(first.respond)?.[0]).toBe(true);
      expect(resolveEffectiveToolInventoryArg()?.sessionId).toBe("private-tools");
      expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
      testing.resetToolsEffectiveCacheForTest();
      runtimeMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
        memorySessionActorOwners.closeDatabase(owner);
        return makeCoreInventory();
      });
      const second = createInvokeParams({ sessionKey });
      await second.invoke();
      expect(firstRespondCall(second.respond)?.[0]).toBe(false);
    } finally {
      await actor.release();
    }
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    expectInvalidResponse(respond, 'unknown session key "missing-session"');
  });

  it("does not reuse a fresh inventory after the same session key is reset", async () => {
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(
        makeCoreInventory({ id: "old_session_tool", label: "Old", description: "Old session" }),
      )
      .mockResolvedValueOnce(
        makeCoreInventory({ id: "new_session_tool", label: "New", description: "New session" }),
      );
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();
    const loaded = runtimeMocks.loadSessionEntry("main:abc");
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: { ...loaded.entry!, sessionId: "session-2" },
    });
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();
    expect(firstRespondCall(first.respond)?.[1]).toMatchObject({
      groups: [{ tools: [{ id: "old_session_tool" }] }],
    });
    expect(firstRespondCall(second.respond)?.[1]).toMatchObject({
      groups: [{ tools: [{ id: "new_session_tool" }] }],
    });
    expect(resolveEffectiveToolInventoryArg(1)?.sessionId).toBe("session-2");
  });

  it("keeps separate base inventory cache entries for spawned workspaces", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    const loaded = runtimeMocks.loadSessionEntry("main:abc");
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: {
        ...loaded.entry,
        sessionId: loaded.entry?.sessionId ?? "session-1",
        updatedAt: loaded.entry?.updatedAt ?? 1,
        spawnedWorkspaceDir: "/tmp/workspace-sandbox",
      },
    });
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveToolInventoryArg(1)?.workspaceDir).toBe("/tmp/workspace-sandbox");
  });

  it("coalesces identical base inventory cache misses while inventory resolution is pending", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    const second = createInvokeParams({ sessionKey: "main:abc" });

    await Promise.all([first.invoke(), second.invoke()]);

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expectResponsesOk(first.respond, second.respond);
  });

  it("returns stale cached base inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    testing.setToolsEffectiveNowForTest(() => now);
    const stalePayload = makeCoreInventory({
      id: "read",
      label: "Read",
      description: "Read files",
    });
    const refreshedPayload = makeCoreInventory();
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(stalePayload)
      .mockResolvedValueOnce(refreshedPayload);

    const initial = createInvokeParams({ sessionKey: "main:abc" });
    await initial.invoke();
    now += 11_000;

    const stale = createInvokeParams({ sessionKey: "main:abc" });
    await stale.invoke();

    expect(firstRespondCall(stale.respond)?.[1]).toBe(stalePayload);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = createInvokeParams({ sessionKey: "main:abc" });
    await fresh.invoke();
    expect(firstRespondCall(fresh.respond)?.[1]).toBe(refreshedPayload);
  });

  it("reports configured MCP servers as not connected without starting them", async () => {
    mockMcpConfigSummary({ serverNames: ["zeta", "alpha"] });
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    const notice = expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(notice?.message).toContain('"alpha", "zeta"');
    expect(notice?.servers).toEqual(["alpha", "zeta"]);
  });

  it("applies inherited MCP denies from the session entry already read by the request", async () => {
    const sessionKey = "agent:main:subagent:prepared-policy";
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: { session: { store: "/tmp/tools-effective-prepared-policy/sessions.sqlite" } },
      agentId: "main",
      storePath: "/tmp/tools-effective-prepared-policy/sessions.sqlite",
      store: {},
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
      entry: {
        sessionId: "prepared-policy-session",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["reproProbe__probe_tool"],
      },
    });
    mockWarmMcpTool();
    runtimeMocks.applyFinalEffectiveToolPolicy.mockImplementationOnce(
      applyFinalEffectiveToolPolicy,
    );

    const { respond, invoke } = createInvokeParams({ sessionKey });
    await invoke();

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expectPayloadGroupIds(respond, ["core"]);
    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledOnce();
  });

  it("projects MCP tools from the session-owning native harness catalog", async () => {
    const loaded = runtimeMocks.loadSessionEntry("main:abc");
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: {
        ...loaded.entry,
        agentHarnessId: "codex",
        toolOverrides: { mcpToolsDeny: { docs: ["delete"] } },
      },
    } as never);
    mockMcpConfigSummary();
    const catalog = makeMcpCatalog();
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(catalog);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([makeMcpTool()]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(loadMcpToolCatalog).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "main:abc",
      workspaceDir: "/tmp/workspace-main",
      mcpServerNames: ["reproProbe"],
      toolOverrides: { mcpToolsDeny: { docs: ["delete"] } },
    });
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
      catalog,
      reservedToolNames: ["exec"],
      includeSessionDenied: true,
    });
    expectPayloadGroupIds(respond, ["core", "mcp"]);
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("does not substitute the core MCP catalog when native inventory is unavailable", async () => {
    const loaded = runtimeMocks.loadSessionEntry("main:abc");
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: { ...loaded.entry, agentHarnessId: "codex" },
    } as never);
    runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValueOnce({
      fingerprint: "mcp:1:test",
      serverNames: ["reproProbe"],
    });
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(undefined);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    runtimeMocks.peekSessionMcpRuntime.mockReturnValue({
      workspaceDir: "/tmp/workspace-main",
      configFingerprint: "mcp:1:test",
      peekCatalog: () => makeMcpCatalog(),
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("preserves raw MCP identities and session denials across sanitized collisions", async () => {
    const enabled = makeMcpTool();
    enabled.name = "collision__alpha-";
    enabled.label = "Alpha bang";
    setPluginToolMeta(enabled, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "collision",
        safeServerName: "collision",
        toolName: "alpha!",
        operation: "tool",
      },
    });
    const denied = makeMcpTool();
    denied.name = "collision__alpha--2";
    denied.label = "Alpha question";
    setPluginToolMeta(denied, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "collision",
        safeServerName: "collision",
        toolName: "alpha?",
        operation: "tool",
        deniedBySession: true,
      },
    });
    const catalog = makeMcpCatalog();
    mockMcpConfigSummary({ serverNames: ["collision"] });
    mockWarmMcpRuntime(catalog);
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([enabled, denied]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
    expect(payload?.groups?.[0]?.tools?.[0]).toEqual({
      id: "exec",
      label: "Exec",
      description: "Run shell commands",
      rawDescription: "Run shell commands",
      source: "core",
    });
    expect(payload?.groups?.[1]?.tools).toEqual([
      expect.objectContaining({
        id: "collision__alpha-",
        mcpServer: "collision",
        mcpToolName: "alpha!",
      }),
      expect.objectContaining({
        id: "collision__alpha--2",
        mcpServer: "collision",
        mcpToolName: "alpha?",
        deniedBySession: true,
      }),
    ]);
  });

  it("quarantines warm MCP tools with schemas the runtime cannot project", async () => {
    mockWarmMcpTool({ type: "array", items: { type: "string" } });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "unsupported-tool-schema:reproProbe__probe_tool");
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
      mockMcpConfigSummary({ serverNames: ["offline", "reproProbe"] });
      mockWarmMcpRuntime({ ...makeMcpCatalog(), diagnostics: [diagnostic] });
      runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce(
        kind === "empty" ? [] : [makeMcpTool()],
      );

      const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
      await invoke();

      expectPayloadGroupIds(respond, kind === "empty" ? ["core"] : ["core", "mcp"]);
      const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
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
    mockMcpConfigSummary();
    mockWarmMcpRuntime(makeMcpCatalog());
    const invalid = makeMcpTool({ type: "array", items: { type: "string" } });
    invalid.name = "reproProbe__invalid";
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([makeMcpTool(), invalid]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core", "mcp"]);
    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
    expect(payload.groups?.[1]?.tools?.map((tool) => tool.id)).toEqual(["reproProbe__probe_tool"]);
    expect(payload.notices?.map((notice) => notice.id)).toEqual([
      "base-notice",
      "unsupported-tool-schema:reproProbe__invalid",
    ]);
    expect(base).toEqual(originalBase);
  });

  it("does not project stale MCP catalogs after config changes", async () => {
    mockMcpConfigSummary({ fingerprint: "mcp:2:test" });
    mockWarmMcpRuntime(makeMcpCatalog(), {
      configFingerprint: "mcp:1:test",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-stale-catalog");
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).not.toHaveBeenCalled();
  });

  it("rejects unknown agent ids before loading the session", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    // `other` is not configured, so the handler rejects before reaching
    // loadSessionEntry; no session mock is queued here on purpose.
    await invoke();
    expectInvalidResponse(respond, 'unknown agent id "other"');
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("loads a bare session through the persisted fixed-store owner", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "global",
      entry: { sessionId: "session-ops-global", updatedAt: 1 },
      storePath: "/tmp/shared-sessions.sqlite",
    } as never);
    runtimeMocks.resolveSessionAgentId.mockReturnValueOnce("ops");
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(makeCoreInventory());

    const { respond, invoke } = createInvokeParams(
      { sessionKey: "global" },
      {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
      },
    );
    await invoke();

    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  });
});
