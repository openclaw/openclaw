import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

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
const context = {
  agentSessionKey: "agent:main:main",
  workspaceDir: "/tmp/requester-workspace",
  agentChannel: "telegram",
  agentAccountId: "123",
  agentTo: "456",
};
const nestedContext = { agentSessionKey: parentKey, workspaceDir: "/tmp/workspace-main" };
const mainContext = { agentSessionKey: "agent:main:main" };

function request(method: string) {
  return gateway.mock.calls.find(([call]) => call.method === method)?.[0];
}

function uncalled(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function spawn(
  params: Omit<Parameters<typeof spawnSubagentDirect>[0], "task"> & { task?: string } = {},
  requester: Parameters<typeof spawnSubagentDirect>[1] = context,
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
    }));
});

beforeEach(async () => {
  await resetRegistry();
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
  expect(request("agent")?.params).not.toHaveProperty("workspaceDir");
  expect(request("agent")?.params).not.toHaveProperty("cwd");
});

it.each([false, true])("inherits sender tools/root (sandboxed=%s)", async (sandboxed) => {
  sandboxStatus.mockReturnValue({ sandboxed });
  const result = await spawn(
    { agentId: "main" },
    {
      ...context,
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
  expect(request("agent")?.params.sessionKey).toBe(result.childSessionKey);
});

it.each([{ agentId: "ops" }, { cwd: "/tmp" }, { worktree: true }])(
  "refuses sender-restricted selection: %j",
  async (selection) => {
    const result = await spawn(selection, { ...context, inheritedToolPolicySource: "sender" });
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
    expect(request("agent")?.params).toMatchObject({
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
