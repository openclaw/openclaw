import assert from "node:assert/strict";
import os from "node:os";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

type BindingService = ReturnType<
  NonNullable<Parameters<typeof loadSubagentSpawnModuleForTest>[0]["getSessionBindingService"]>
>;
let bindingService: BindingService;
const gateway = vi.fn();
const loadStore = vi.fn();
const updateStore = vi.fn();
const registerRun = vi.fn();
const forkSession = vi.fn();
const initializeContext = vi.fn();
const resolveEngine = vi.fn();
let store: Record<string, Record<string, unknown>> = {};
let depth = 0;
let activeChildren = 0;
const parentKey = "agent:main:subagent:parent";
const sandboxStatus = vi.fn<(params: { sessionKey?: string }) => { sandboxed: boolean }>();
let config = createSubagentSpawnTestConfig("/tmp/workspace-main");
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetRegistry: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
const requesterContext = {
  agentSessionKey: "agent:main:main",
  workspaceDir: "/tmp/requester-workspace",
  agentChannel: "telegram",
  agentAccountId: "123",
  agentTo: "456",
};
const nestedContext = { agentSessionKey: parentKey, workspaceDir: "/tmp/workspace-main" };
const mainContext = { agentSessionKey: "agent:main:main" };

function gatewayRequest(method: string) {
  return gateway.mock.calls.find(([call]) => call.method === method)?.[0];
}

function uncalled(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function spawn(
  params: Omit<Parameters<typeof spawnSubagentDirect>[0], "task"> & { task?: string } = {},
  requester: Parameters<typeof spawnSubagentDirect>[1] = requesterContext,
) {
  return spawnSubagentDirect({ task: "hello", ...params }, requester);
}

function parentSession(entry: Record<string, unknown>) {
  loadStore.mockReturnValue({
    "agent:main:main": { sessionId: "parent", ...entry },
  });
}

function defaults(values: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
    ...overrides,
    agents: { defaults: { workspace: "/tmp/workspace-main", ...values } },
  });
}

function persistedModel(provider: string, model: string, overrideSource: "user" | "auto") {
  expectPersistedRuntimeModel({
    persistedStore: store,
    sessionKey: /^agent:main:subagent:/,
    provider,
    model,
    overrideSource,
  });
  return Object.values(store)[0];
}

function limits(subagents: Record<string, unknown>) {
  loadStore.mockReturnValue({
    [parentKey]: { sessionId: "nested-parent", updatedAt: 1 },
  });
  defaults({ subagents });
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests: resetRegistry, spawnSubagentDirect } =
    await loadSubagentSpawnModuleForTest({
      callGatewayMock: gateway,
      getRuntimeConfig: () => config,
      loadSessionStoreMock: loadStore,
      updateSessionStoreMock: updateStore,
      registerSubagentRunMock: registerRun,
      forkSessionFromParentMock: forkSession,
      ensureContextEnginesInitializedMock: initializeContext,
      resolveContextEngineMock: resolveEngine,
      getSubagentDepthFromSessionStore: (key) => (key === parentKey ? depth : 0),
      countActiveRunsForSession: (key) => (key === parentKey ? activeChildren : 0),
      resolveSandboxRuntimeStatus: sandboxStatus,
      resetModules: false,
      getSessionBindingService: () => bindingService,
    }));
});

beforeEach(async () => {
  await resetRegistry();
  bindingService = {
    getCapabilities: () => ({ adapterAvailable: false, bindSupported: false, placements: [] }),
    bind: async () => {
      throw new Error("session binding adapter unavailable");
    },
    listBySession: () => [],
  };
  for (const mock of [gateway, registerRun, updateStore, forkSession, initializeContext]) {
    mock.mockReset();
  }
  loadStore.mockReset().mockReturnValue({});
  depth = 0;
  activeChildren = 0;
  store = {};
  resolveEngine.mockReset().mockResolvedValue({});
  installSessionStoreCaptureMock(updateStore, {
    onStore: (value) => {
      store = value;
    },
  });
  setupAcceptedSubagentGatewayMock(gateway);
  sandboxStatus.mockReset().mockReturnValue({ sandboxed: false });
  config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
    session: { threadBindings: { defaultSpawnContext: "isolated" } },
    agents: {
      entries: {
        main: { workspace: "/tmp/workspace-main", subagents: { allowAgents: ["main", "ops"] } },
        ops: { workspace: "/tmp/workspace-ops" },
      },
    },
  });
});

it("inherits incognito storage ownership without contributor attribution", async () => {
  const parent = "agent:main:dashboard:incognito-parent";
  loadStore.mockReturnValue({
    [parent]: {
      sessionId: "incognito-parent-session",
      inheritedGitContributorProfileIds: ["inherited-human"],
      participants: [{ identity: { type: "profile", id: "direct-human" } }],
    },
  });
  const patches: Record<string, unknown>[] = [];
  installSessionStoreCaptureMock(updateStore, {
    onStore: (updated) => patches.push(...Object.values(updated)),
  });
  const result = await spawn({}, { agentSessionKey: parent });
  expect(result.status).toBe("accepted");
  expect(result.childSessionKey).toMatch(/^agent:main:subagent:incognito-/u);
  expect(patches).toContainEqual(expect.objectContaining({ incognito: true }));
  for (const patch of patches) {
    expect(patch).not.toHaveProperty("inheritedGitContributorProfileIds");
  }
  expect(updateStore).toHaveBeenCalledWith(
    resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    expect.any(Function),
  );
});

it("keeps explicit cwd separate from the target agent workspace and Gateway params", async () => {
  const result = await spawn({ agentId: "ops", cwd: "/tmp/task-repo" });
  expect(result.status).toBe("accepted");
  expect(registerRun.mock.calls[0]?.[0]).toMatchObject({
    childAgentId: "ops",
    workspaceDir: "/tmp/workspace-ops",
  });
  expect(store[result.childSessionKey!]).toMatchObject({
    spawnedWorkspaceDir: "/tmp/workspace-ops",
    spawnedCwd: "/tmp/task-repo",
  });
  expect(gatewayRequest("agent")?.params).not.toHaveProperty("workspaceDir");
  expect(gatewayRequest("agent")?.params).not.toHaveProperty("cwd");
});

it.each([false, true])("inherits sender tools/root (sandboxed=%s)", async (sandboxed) => {
  sandboxStatus.mockReturnValue({ sandboxed });
  const result = await spawn(
    { agentId: "main" },
    {
      ...requesterContext,
      inheritedToolPolicySource: "sender",
      inheritedToolAllowlist: ["read", "sessions_spawn", ""],
      inheritedToolDenylist: ["bash", "exec", "read", ""],
      sessionPermissionPolicy: { mode: "read-only", root: "/tmp/requester-workspace/project" },
    },
  );
  expect(result.status).toBe("accepted");
  expect(store[result.childSessionKey!]).toMatchObject({
    spawnedWorkspaceDir: "/tmp/requester-workspace",
    ...(sandboxed ? {} : { spawnedCwd: "/tmp/requester-workspace/project" }),
    sessionRoot: "/tmp/requester-workspace/project",
    permissionMode: "read-only",
    inheritedToolPolicySource: "sender",
    inheritedToolAllow: ["read", "sessions_spawn"],
    inheritedToolDeny: ["exec", "read"],
    inheritedToolPolicyVersion: 1,
  });
  if (sandboxed) {
    expect(store[result.childSessionKey!]).not.toHaveProperty("spawnedCwd");
  }
  expect(gatewayRequest("agent")?.params.sessionKey).toBe(result.childSessionKey);
});

it.each([{ agentId: "ops" }, { cwd: "/tmp" }, { worktree: true }])(
  "refuses sender-restricted selection: %j",
  async (selection) => {
    const result = await spawn(selection, {
      ...requesterContext,
      inheritedToolPolicySource: "sender",
    });
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("This sender"),
    });
    uncalled(updateStore, gateway);
  },
);

it("rejects cwd overrides for sandboxed children before launch", async () => {
  sandboxStatus.mockImplementation(({ sessionKey }) => ({
    sandboxed: Boolean(sessionKey?.includes(":subagent:")),
  }));
  const result = await spawn({ agentId: "ops", cwd: "/tmp/task-repo" });
  expect(result).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("cwd override is not supported for sandboxed subagent runs"),
  });
  uncalled(gateway, registerRun);
});

it.each(["lightweight", "timer-safe TTL"] as const)("prepares %s context", async (mode) => {
  config = createSubagentSpawnTestConfig();
  const prepare = vi.fn(async () => undefined);
  resolveEngine.mockResolvedValue({ prepareSubagentSpawn: prepare });
  const params =
    mode === "lightweight"
      ? { context: "isolated" as const, lightContext: true }
      : { runTimeoutSeconds: Number.MAX_SAFE_INTEGER };
  const result = await spawn(params, { agentSessionKey: "main" });
  expect(result.status).toBe("accepted");
  if (mode === "lightweight") {
    uncalled(forkSession, initializeContext, resolveEngine, prepare);
    expect(gatewayRequest("agent")?.params).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  } else {
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: MAX_TIMER_TIMEOUT_MS }));
  }
});

it.each([
  [undefined, "thread: true"],
  [true, "not running on a channel"],
] as const)("suggests session alternatives (thread=%s)", async (thread, guidance) => {
  const result = await spawn(
    { mode: "session", thread, context: "isolated" },
    { agentSessionKey: "agent:main:main", agentChannel: "webchat" },
  );
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error).toContain(guidance);
    expect(result.error).toContain('mode="run"');
    expect(result.error).not.toContain("sessions_send");
  }
});

it.each([
  [
    1,
    0,
    "sessions_spawn is not allowed at this depth (current depth: 1, max: 1; agents.defaults.subagents.maxSpawnDepth).",
  ],
  [
    2,
    1,
    "sessions_spawn has reached max active children for this session (1/1; agents.defaults.subagents.maxChildrenPerAgent).",
  ],
] as const)(
  "rejects depth=%s children=%s before persistence",
  async (maxSpawnDepth, children, error) => {
    limits({ maxSpawnDepth, maxChildrenPerAgent: 1 });
    depth = 1;
    activeChildren = children;
    const result = await spawn({ completionTarget: "parent" }, nestedContext);
    expect(result).toMatchObject({ status: "forbidden", error });
    uncalled(registerRun, updateStore);
  },
);

it("persists leaf capabilities below the depth limit independently of maxConcurrent", async () => {
  limits({ maxSpawnDepth: 2, maxChildrenPerAgent: 5, maxConcurrent: 1 });
  depth = 1;
  activeChildren = 1;
  const result = await spawn({ completionTarget: "parent" }, nestedContext);
  expect(result).toMatchObject({
    status: "accepted",
    runId: "run-1",
    completionTarget: "parent",
    childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
  });
  expect(store[result.childSessionKey!]).toMatchObject({
    spawnedBy: parentKey,
    spawnDepth: 2,
    subagentRole: "leaf",
    subagentControlScope: "none",
    spawnedWorkspaceDir: expect.any(String),
  });
});

it.each(["user", "auto"] as const)("separates %s model from auth profile", async (source) => {
  const resolvedModel = "openai/gpt-5.6-luna";
  const model = `${resolvedModel}@openai:test-profile`;
  if (source === "auto") {
    defaults({ subagents: { model } });
  }
  const result = await spawn(source === "user" ? { model } : {}, {
    ...mainContext,
    agentChannel: "guildchat",
  });
  expect(result).toMatchObject({ status: "accepted", resolvedModel });
  const entry = persistedModel("openai", "gpt-5.6-luna", source);
  expect(entry).toMatchObject({
    authProfileOverride: "openai:test-profile",
    authProfileOverrideSource: "user",
    ...(source === "auto"
      ? {
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-5.6-luna",
        }
      : {}),
  });
});

it.each([
  { source: "active", model: "custom/model" },
  { source: "persisted", model: "middle" },
])("preserves $source model $model", async ({ source, model }) => {
  const [{ createPluginMetadataSnapshotFixture }, { withPluginRuntimeGenerationScope }] =
    await Promise.all([
      import("../../../plugins/plugin-metadata.test-support.js"),
      import("../../../plugins/runtime/generation-scope.js"),
    ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "model-identity-fixture",
        providers: ["custom"],
        modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } },
      },
    ],
  });
  parentSession({
    providerOverride: "custom",
    modelOverride: model,
    modelOverrideRouteResolution: "resolved",
  });
  const result = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
    spawn(
      {},
      {
        ...mainContext,
        ...(source === "active" ? { requesterModel: { provider: "custom", model } } : {}),
      },
    ),
  );

  expect(result).toMatchObject({ status: "accepted", resolvedModel: `custom/${model}` });
  const entry = persistedModel("custom", model, "auto");
  expect(entry?.modelOverrideRouteResolution).toBe("resolved");
});

it.each([
  ["different model", "custom/model-b", true, undefined, undefined, undefined],
  ["same model alias explicit off", "same-model", false, undefined, undefined, false],
  ["explicit child off", "custom/model-b", true, false, undefined, false],
  ["active model differs from saved", "custom/model-a", undefined, undefined, "model-b", true],
] as const)(
  "scopes inherited Fast mode: %s",
  async (_name, model, parentMode, override, savedModel, expected) => {
    defaults(
      {
        model: { primary: "custom/model-a" },
        models: {
          "custom/model-a": { alias: "same-model", params: { fastMode: true } },
          "custom/model-b": { params: { fastMode: false } },
        },
      },
      { tools: { swarm: { enabled: true } } },
    );
    parentSession({
      providerOverride: "custom",
      modelOverride: savedModel ?? "model-a",
      fastMode: parentMode,
    });
    const result = await spawn(
      { model, fastMode: override },
      {
        ...mainContext,
        requesterModel: { provider: "custom", model: "model-a" },
      },
    );

    expect(result.status).toBe("accepted");
    const persistedEntry = Object.values(store)[0];
    expect(persistedEntry).toBeDefined();
    expect(persistedEntry?.fastMode).toBe(expected);
  },
);

const requireRecord = createRequireRecord("record", "expected-non-array-record");
let pluginRuntime: typeof import("../../../plugins/runtime.js");
let pluginFixtures: typeof import("../../../test-utils/channel-plugins.js");
let routable = true;
const caller = {
  agentSessionKey: "agent:main:main",
  agentChannel: "matrix",
  agentTo: "room:parent",
};
function spawnSession(
  task: string,
  context: Parameters<typeof spawnSubagentDirect>[1] = caller,
  request: Partial<Parameters<typeof spawnSubagentDirect>[0]> = {},
) {
  return spawnSubagentDirect(
    { task, thread: true, mode: "session", context: "isolated", ...request },
    context,
  );
}
function boundSession(request: Parameters<NonNullable<BindingService["bind"]>>[0]) {
  const { targetSessionKey, targetKind, conversation } = request;
  return { targetSessionKey, targetKind, status: "active" as const, conversation };
}
function agentParams() {
  return requireRecord(gateway.mock.calls.find(([call]) => call.method === "agent")?.[0].params);
}
function registered() {
  return requireRecord(registerRun.mock.calls[0]?.[0]);
}
function makeBindingService(
  bind: BindingService["bind"],
  listBySession: BindingService["listBySession"] = () => [],
): BindingService {
  return {
    getCapabilities: () => ({ adapterAvailable: true, bindSupported: true, placements: ["child"] }),
    bind,
    listBySession,
  };
}

describe("spawnSubagentDirect thread binding", () => {
  beforeAll(async () => {
    pluginRuntime = await import("../../../plugins/runtime.js");
    pluginFixtures = await import("../../../test-utils/channel-plugins.js");
  });
  beforeEach(() => {
    routable = true;
    config = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: { entries: { main: { workspace: "/tmp/workspace-main" } } },
      session: { threadBindings: { defaultSpawnContext: "isolated" } },
    });
    bindingService = makeBindingService(async (request) => boundSession(request));
    pluginRuntime.setActivePluginRegistry(
      pluginFixtures.createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...pluginFixtures.createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) => {
                if (!routable) {
                  return {};
                }
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                return parent && parent !== child
                  ? { to: `room:${parent}`, threadId: child }
                  : { to: `room:${child}` };
              },
            },
          },
        },
      ]),
    );
  });

  it.each([
    { mode: "run", thread: false, route: true, announce: false, cleanup: "delete" },
    { mode: "run", thread: true, route: true, announce: true, cleanup: "keep" },
    { mode: "session", thread: true, route: false, announce: true, cleanup: "keep" },
  ] as const)(
    "aligns $mode thread=$thread route=$route guidance and delivery",
    async ({ mode, thread, route, announce, cleanup }) => {
      routable = route;
      const result = await spawnSubagentDirect(
        { task: "Return findings", mode, thread, expectsCompletionMessage: announce, cleanup },
        caller,
      );
      expect(result.status).toBe("accepted");
      expect(agentParams().deliver).toBe(false);
      expect(result.expectsCompletionMessage).toBe(announce);
      expect(registered().expectsCompletionMessage).toBe(announce);
      const { extraSystemPrompt, message } = agentParams();
      assert(typeof extraSystemPrompt === "string", "child system prompt must be text");
      assert(typeof message === "string", "child task must be text");
      const guidance = `${extraSystemPrompt}\n${message}`;
      const contract = announce ? /completion event/i : /no completion notification/i;
      expect(guidance).toMatch(contract);
      expect(result.note).toMatch(contract);
      if (cleanup === "delete") {
        expect(registered()).toMatchObject({ cleanup: "delete" });
        expect(guidance).not.toContain("remains in the child session");
        expect(result.note).not.toContain("remains in the child session");
        expect(guidance).not.toMatch(/final auto-reported|Results auto-announce/);
        expect(result.note).not.toMatch(/Auto-announce is push-based/);
      }
    },
  );

  it.each([false, true])(
    "routes bound delivery separately from requester origin (generic=%s)",
    async (generic) => {
      const conversation = generic
        ? { channel: "collabchat", accountId: "work", conversationId: "collab_dm_1" }
        : {
            channel: "matrix",
            accountId: "bot-alpha",
            conversationId: "$thread-root",
            parentConversationId: "!room:example.org",
          };
      const bind = vi.fn<NonNullable<BindingService["bind"]>>(async (request) => ({
        ...boundSession(request),
        conversation,
      }));
      bindingService = makeBindingService(bind, () =>
        generic ? [{ status: "active", conversation }] : [],
      );
      if (!generic) {
        config = createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["bot-alpha"] } },
            entries: {
              main: { workspace: "/tmp/workspace-main" },
              "bot-alpha": { workspace: "/tmp/workspace-bot-alpha" },
            },
          },
          bindings: [
            {
              type: "route",
              agentId: "bot-alpha",
              match: {
                channel: "matrix",
                peer: { kind: "channel", id: "!room:example.org" },
                accountId: "bot-alpha",
              },
            },
          ],
        });
      }
      const result = await spawnSession(
        "reply with a marker",
        { ...caller, agentAccountId: "bot-beta", agentTo: "room:!room:example.org" },
        { agentId: generic ? undefined : "bot-alpha" },
      );
      expect(result.status).toBe("accepted");
      expect(bind).toHaveBeenCalledOnce();
      if (!generic) {
        expect(bind.mock.calls[0]?.[0].conversation).toMatchObject({
          channel: "matrix",
          accountId: "bot-alpha",
          conversationId: "!room:example.org",
        });
      }
      expect(agentParams()).toMatchObject({
        channel: conversation.channel,
        accountId: conversation.accountId,
        to: generic ? "channel:collab_dm_1" : "room:!room:example.org",
        deliver: true,
        ...(generic ? {} : { threadId: "$thread-root" }),
      });
      expect(registered()).toMatchObject({
        requesterOrigin: { channel: "matrix", accountId: "bot-beta", to: "room:!room:example.org" },
        expectsCompletionMessage: false,
        spawnMode: "session",
      });
      expect(result.note).toMatch(/directly to the bound thread/i);
      expect(agentParams().extraSystemPrompt).toMatch(/directly to the bound thread/i);
    },
  );

  it("preserves lifecycle cleanup after thread registration fails", async () => {
    registerRun.mockRejectedValue(new Error("registry unavailable"));
    const result = await spawnSession("fail after binding");
    expect(result).toMatchObject({
      status: "error",
      error: "Failed to register subagent run: registry unavailable",
      runId: "run-1",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    expect(gateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        scopes: ["operator.admin"],
        params: expect.objectContaining({
          key: result.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
        }),
      }),
    );
  });

  it.each([
    { origin: "run-bound-grant", thread: undefined },
    { origin: "run-bound-grant", thread: "t-123" },
    { origin: "caller-token", thread: "caller-thread" },
  ] as const)(
    "validates CLI conversation authority ($origin, $thread)",
    async ({ origin, thread: currentThreadTs }) => {
      const bind = vi.fn<NonNullable<BindingService["bind"]>>(bindingService.bind);
      bindingService = makeBindingService(bind);
      const untrusted = origin === "caller-token";
      const result = await spawnSession("CLI turn", {
        agentSessionKey: caller.agentSessionKey,
        agentChannel: caller.agentChannel,
        ...(untrusted ? {} : { agentAccountId: "bot-beta" }),
        currentChannelId: untrusted ? "!caller-selected-room" : "!room:example.org",
        currentThreadTs,
        currentConversationOrigin: origin,
      });
      if (untrusted) {
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining("Could not resolve a matrix conversation"),
        });
        expect(bind).not.toHaveBeenCalled();
        expect(registerRun).not.toHaveBeenCalled();
        return;
      }
      expect(result.status).toBe("accepted");
      expect(bind).toHaveBeenCalledOnce();
      expect(bind.mock.calls[0]?.[0].conversation).toMatchObject({
        channel: "matrix",
        accountId: "bot-beta",
        conversationId: currentThreadTs ?? "!room:example.org",
        ...(currentThreadTs ? { parentConversationId: "!room:example.org" } : {}),
      });
      expect(registered()).toMatchObject({ requesterOrigin: { to: "!room:example.org" } });
    },
  );
});
