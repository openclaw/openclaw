import os from "node:os";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
const forkSessionFromParentMock = vi.fn();
const ensureContextEnginesInitializedMock = vi.fn();
const resolveContextEngineMock = vi.fn();
let store: Record<string, Record<string, unknown>> = {};
let depth = 0;
let activeChildren = 0;
const parentKey = "agent:main:subagent:parent";
const resolveSandboxRuntimeStatusMock =
  vi.fn<(params: { sessionKey?: string }) => { sandboxed: boolean }>();
let config = createSubagentSpawnTestConfig("/tmp/workspace-main");
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
const context = {
  agentSessionKey: "agent:main:main",
  workspaceDir: "/tmp/requester-workspace",
  agentChannel: "telegram",
  agentAccountId: "123",
  agentTo: "456",
};

function request(method: string) {
  return callGatewayMock.mock.calls.find(([call]) => call.method === method)?.[0];
}

function limits(subagents: Record<string, unknown>) {
  loadSessionStoreMock.mockReturnValue({
    [parentKey]: { sessionId: "nested-parent", updatedAt: 1 },
  });
  config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: { defaults: { workspace: "/tmp/workspace-main", subagents } },
  });
}

async function spawnChild(params: Parameters<typeof spawnSubagentDirect>[0] = { task: "hello" }) {
  return spawnSubagentDirect(params, {
    agentSessionKey: parentKey,
    workspaceDir: "/tmp/workspace-main",
  });
}

function child(result: Awaited<ReturnType<typeof spawnSubagentDirect>>) {
  expect(result.status).toBe("accepted");
  expect(result.runId).toBe("run-1");
  expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
  const entry = store[result.childSessionKey!];
  expect(entry).toBeDefined();
  return entry!;
}

describe("spawnSubagentDirect child session preparation", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      loadSessionStoreMock,
      updateSessionStoreMock,
      registerSubagentRunMock,
      forkSessionFromParentMock,
      ensureContextEnginesInitializedMock,
      resolveContextEngineMock,
      getSubagentDepthFromSessionStore: (key) => (key === parentKey ? depth : 0),
      countActiveRunsForSession: (key) => (key === parentKey ? activeChildren : 0),
      resolveSandboxRuntimeStatus: resolveSandboxRuntimeStatusMock,
      resetModules: false,
    }));
  });

  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    registerSubagentRunMock.mockReset();
    updateSessionStoreMock.mockReset();
    depth = 0;
    activeChildren = 0;
    store = {};
    forkSessionFromParentMock.mockReset();
    ensureContextEnginesInitializedMock.mockReset();
    resolveContextEngineMock.mockReset().mockResolvedValue({});
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (value) => {
        store = value;
      },
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    resolveSandboxRuntimeStatusMock.mockReset().mockReturnValue({ sandboxed: false });
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
    loadSessionStoreMock.mockReturnValue({
      [parent]: {
        sessionId: "incognito-parent-session",
        inheritedGitContributorProfileIds: ["inherited-human"],
        participants: [{ identity: { type: "profile", id: "direct-human" } }],
      },
    });
    const patches: Record<string, unknown>[] = [];
    updateSessionStoreMock.mockImplementation(
      async (
        _path: string,
        mutate: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const updated: Record<string, Record<string, unknown>> = {};
        await mutate(updated);
        patches.push(...Object.values(updated));
        return updated;
      },
    );
    const result = await spawnSubagentDirect(
      { task: "keep this child in memory" },
      { agentSessionKey: parent },
    );
    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:incognito-/u);
    expect(patches).toContainEqual(expect.objectContaining({ incognito: true }));
    for (const patch of patches) {
      expect(patch).not.toHaveProperty("inheritedGitContributorProfileIds");
    }
    expect(updateSessionStoreMock).toHaveBeenCalledWith(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      expect.any(Function),
    );
  });

  it("keeps explicit cwd separate from the target agent workspace and Gateway params", async () => {
    const result = await spawnSubagentDirect(
      { task: "inspect cwd", agentId: "ops", cwd: "/tmp/task-repo" },
      context,
    );
    expect(result.status).toBe("accepted");
    expect(registerSubagentRunMock.mock.calls[0]?.[0].workspaceDir).toBe("/tmp/workspace-ops");
    expect(store[result.childSessionKey!]).toMatchObject({
      spawnedWorkspaceDir: "/tmp/workspace-ops",
      spawnedCwd: "/tmp/task-repo",
    });
    expect(request("agent")?.params).not.toHaveProperty("workspaceDir");
    expect(request("agent")?.params).not.toHaveProperty("cwd");
  });

  it.each([false, true])(
    "keeps a restricted same-agent helper's tools and root (sandboxed=%s)",
    async (sandboxed) => {
      resolveSandboxRuntimeStatusMock.mockReturnValue({ sandboxed });
      const result = await spawnSubagentDirect(
        { task: "inspect the assigned project", agentId: "main" },
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
    },
  );

  it.each([{ agentId: "ops" }, { cwd: "/tmp" }, { worktree: true }])(
    "refuses a restricted helper that changes its agent or root: %j",
    async (selection) => {
      const result = await spawnSubagentDirect(
        { task: "inspect", ...selection },
        { ...context, inheritedToolPolicySource: "sender" },
      );
      expect(result).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("This sender"),
      });
      expect(updateSessionStoreMock).not.toHaveBeenCalled();
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("rejects cwd overrides for sandboxed children before launch", async () => {
    resolveSandboxRuntimeStatusMock.mockImplementation(({ sessionKey }) => ({
      sandboxed: Boolean(sessionKey?.includes(":subagent:")),
    }));
    const result = await spawnSubagentDirect(
      { task: "inspect cwd", agentId: "ops", cwd: "/tmp/task-repo" },
      context,
    );
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("cwd override is not supported for sandboxed subagent runs"),
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("keeps lightContext isolated spawns out of context-engine preparation", async () => {
    config = createSubagentSpawnTestConfig();
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      { task: "clean worker", context: "isolated", lightContext: true },
      { agentSessionKey: "main" },
    );

    expect(result.status).toBe("accepted");
    expect(forkSessionFromParentMock).not.toHaveBeenCalled();
    expect(ensureContextEnginesInitializedMock).not.toHaveBeenCalled();
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
    expect(prepareSubagentSpawn).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "default",
        }),
      }),
    );
  });

  it("caps oversized context engine subagent TTLs at the timer-safe ceiling", async () => {
    config = createSubagentSpawnTestConfig();
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      {
        task: "clean worker",
        runTimeoutSeconds: Number.MAX_SAFE_INTEGER,
      },
      { agentSessionKey: "main" },
    );

    expect(result.status).toBe("accepted");
    expect(prepareSubagentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("names usable alternatives before a thread retry", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("thread: true");
      expect(result.error).toContain('mode="run"');
      expect(result.error).not.toContain("sessions_send");
    }
  });

  it("rejects thread=true with actionable guidance when no hook is registered", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
        thread: true,
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("not running on a channel");
      expect(result.error).toContain('mode="run"');
      expect(result.error).not.toContain("sessions_send");
    }
  });

  it.each([
    {
      name: "depth",
      maxSpawnDepth: 1,
      children: 0,
      error:
        "sessions_spawn is not allowed at this depth (current depth: 1, max: 1; agents.defaults.subagents.maxSpawnDepth).",
    },
    {
      name: "child cap",
      maxSpawnDepth: 2,
      children: 1,
      error:
        "sessions_spawn has reached max active children for this session (1/1; agents.defaults.subagents.maxChildrenPerAgent).",
    },
  ])("rejects the $name limit before persistence", async ({ maxSpawnDepth, children, error }) => {
    limits({ maxSpawnDepth, maxChildrenPerAgent: 1 });
    depth = 1;
    activeChildren = children;
    const result = await spawnChild({ task: "hello", completionTarget: "parent" });
    expect(result).toMatchObject({ status: "forbidden", error });
    expect(registerSubagentRunMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("persists leaf capabilities below the depth limit independently of maxConcurrent", async () => {
    limits({ maxSpawnDepth: 2, maxChildrenPerAgent: 5, maxConcurrent: 1 });
    depth = 1;
    activeChildren = 1;
    const result = await spawnChild({ task: "hello", completionTarget: "parent" });
    expect(result.completionTarget).toBe("parent");
    const entry = child(result);
    expect(entry).toMatchObject({
      spawnedBy: parentKey,
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
    });
    expect(entry.spawnedWorkspaceDir).toEqual(expect.any(String));
  });

  it.each(["user", "auto"] as const)(
    "persists a %s-selected model separately from its auth profile",
    async (source) => {
      const model = "openai/gpt-5.6-luna@openai:test-profile";
      if (source === "auto") {
        config = createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: { defaults: { workspace: os.tmpdir(), subagents: { model } } },
        });
      }
      const result = await spawnSubagentDirect(
        { task: "test", ...(source === "user" ? { model } : {}) },
        { agentSessionKey: "agent:main:main", agentChannel: "guildchat" },
      );
      expect(result.status).toBe("accepted");
      expect(result.resolvedModel).toBe("openai/gpt-5.6-luna");
      expectPersistedRuntimeModel({
        persistedStore: store,
        sessionKey: /^agent:main:subagent:/,
        provider: "openai",
        model: "gpt-5.6-luna",
        overrideSource: source,
      });
      const [, entry] = Object.entries(store)[0] ?? [];
      expect(entry).toMatchObject({
        authProfileOverride: "openai:test-profile",
        authProfileOverrideSource: "user",
      });
      if (source === "auto") {
        expect(entry).toMatchObject({
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-5.6-luna",
        });
      }
    },
  );

  it.each([
    { source: "active", model: "custom/model" },
    { source: "persisted", model: "middle" },
  ])("preserves the $source resolved model $model in child state", async ({ source, model }) => {
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
    loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        sessionId: "model-identity-parent",
        providerOverride: "custom",
        modelOverride: model,
        modelOverrideRouteResolution: "resolved",
      },
    });
    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      spawnSubagentDirect(
        { task: "preserve the selected model" },
        {
          agentSessionKey: "agent:main:main",
          ...(source === "active" ? { requesterModel: { provider: "custom", model } } : {}),
        },
      ),
    );

    expect(result.status).toBe("accepted");
    expectPersistedRuntimeModel({
      persistedStore: store,
      sessionKey: /^agent:main:subagent:/,
      provider: "custom",
      model,
      overrideSource: "auto",
    });
    const [, entry] = Object.entries(store)[0] ?? [];
    expect(entry?.modelOverrideRouteResolution).toBe("resolved");
    expect(result.resolvedModel).toBe(`custom/${model}`);
  });

  it.each([
    { name: "different model", model: "custom/model-b", parentMode: true, expected: undefined },
    {
      name: "same model alias explicit off",
      model: "same-model",
      parentMode: false,
      expected: false,
    },
    {
      name: "explicit child off",
      model: "custom/model-b",
      parentMode: true,
      override: false,
      expected: false,
    },
    {
      name: "active model differs from saved selection",
      model: "custom/model-a",
      savedModel: "model-b",
      expected: true,
    },
  ])(
    "scopes inherited Fast mode: $name",
    async ({ model, parentMode, override, savedModel, expected }) => {
      config = createSubagentSpawnTestConfig(os.tmpdir(), {
        tools: { swarm: { enabled: true } },
        agents: {
          defaults: {
            workspace: os.tmpdir(),
            model: { primary: "custom/model-a" },
            models: {
              "custom/model-a": { alias: "same-model", params: { fastMode: true } },
              "custom/model-b": { params: { fastMode: false } },
            },
          },
        },
      });
      loadSessionStoreMock.mockReturnValue({
        "agent:main:main": {
          sessionId: "fast-mode-parent",
          providerOverride: "custom",
          modelOverride: savedModel ?? "model-a",
          fastMode: parentMode,
        },
      });
      const result = await spawnSubagentDirect(
        { task: "test", model, fastMode: override },
        {
          agentSessionKey: "agent:main:main",
          requesterModel: { provider: "custom", model: "model-a" },
        },
      );

      expect(result.status).toBe("accepted");
      const [, persistedEntry] = Object.entries(store)[0] ?? [];
      expect(persistedEntry).toBeDefined();
      expect(persistedEntry?.fastMode).toBe(expected);
    },
  );
});
