// Subagent spawn workspace tests cover same-agent inheritance, cross-agent
// workspace selection, sandboxed cwd rejection, and cleanup deletion calls.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

type TestAgentConfig = {
  id?: string;
  workspace?: string;
  subagents?: {
    allowAgents?: string[];
  };
};

type TestConfig = {
  agents?: {
    list?: TestAgentConfig[];
  };
};
type TestBindingRequest = {
  targetSessionKey: string;
  targetKind?: string;
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn<
    (params: { sessionKey?: string }) => { sandboxed: boolean }
  >(() => ({ sandboxed: false })),
  hookRunner: {
    hasHooks: vi.fn(() => false),
  },
  bindingService: {
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["child"] as Array<"current" | "child">,
    })),
    bind: vi.fn(async (request: TestBindingRequest) => {
      const conversation = request.conversation;
      return {
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation,
      };
    }),
    listBySession: vi.fn(() => []),
  },
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: {
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    session: {
      threadBindings: {
        defaultSpawnContext: "isolated",
      },
    },
    ...overrides,
  });
}

function createCrossAgentConfig() {
  return createConfigOverride({
    agents: {
      list: [
        { id: "main", workspace: "/tmp/workspace-main", subagents: { allowAgents: ["ops"] } },
        { id: "ops", workspace: "/tmp/workspace-ops" },
      ],
    },
  });
}

function resolveTestAgentConfig(cfg: Record<string, unknown>, agentId: string) {
  return (cfg as TestConfig).agents?.list?.find((entry) => entry.id === agentId);
}

function resolveTestAgentWorkspace(cfg: Record<string, unknown>, agentId: string) {
  return resolveTestAgentConfig(cfg, agentId)?.workspace ?? `/tmp/workspace-${agentId}`;
}

function getRegisteredRun() {
  return hoisted.registerSubagentRunMock.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
}

function findLastSessionDeleteCall() {
  return hoisted.callGatewayMock.mock.calls.findLast(
    ([request]) => (request as { method?: string }).method === "sessions.delete",
  )?.[0] as
    | {
        params?: {
          key?: string;
          deleteTranscript?: boolean;
          emitLifecycleHooks?: boolean;
        };
      }
    | undefined;
}

async function expectAcceptedWorkspace(params: { agentId: string; expectedWorkspaceDir: string }) {
  // Registered run workspace is the canonical child workspace; gateway params
  // should not receive ad hoc workspace overrides for native subagent calls.
  const result = await spawnSubagentDirect(
    {
      task: "inspect workspace",
      agentId: params.agentId,
    },
    {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    },
  );

  expect(result.status).toBe("accepted");
  expect(getRegisteredRun()?.workspaceDir).toBe(params.expectedWorkspaceDir);
}

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      loadSessionStoreMock: hoisted.loadSessionStoreMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      hookRunner: hoisted.hookRunner,
      resolveAgentConfig: resolveTestAgentConfig,
      resolveAgentWorkspaceDir: resolveTestAgentWorkspace,
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      getSessionBindingService: () => hoisted.bindingService,
      resetModules: false,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.updateSessionStoreMock.mockReset();
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
    hoisted.registerSubagentRunMock.mockClear();
    hoisted.resolveSandboxRuntimeStatusMock.mockReset();
    hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(() => ({ sandboxed: false }));
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.hasHooks.mockImplementation(() => false);
    hoisted.bindingService.getCapabilities.mockClear();
    hoisted.bindingService.bind.mockClear();
    hoisted.bindingService.listBySession.mockClear();
    hoisted.configOverride = createConfigOverride();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });

  it("inherits incognito storage ownership for direct children", async () => {
    const requesterSessionKey = "agent:main:dashboard:incognito-parent";
    hoisted.loadSessionStoreMock.mockReturnValue({
      [requesterSessionKey]: {
        sessionId: "incognito-parent-session",
        inheritedGitContributorProfileIds: ["inherited-human"],
        participants: [{ identity: { type: "profile", id: "direct-human" } }],
      },
    });
    const sessionPatches: Record<string, unknown>[] = [];
    const sessionStorePaths: string[] = [];
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        sessionStorePaths.push(storePath);
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        sessionPatches.push(...Object.values(store));
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      { task: "keep this child in memory" },
      { agentSessionKey: requesterSessionKey },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:incognito-/u);
    expect(sessionPatches).toContainEqual(expect.objectContaining({ incognito: true }));
    for (const patch of sessionPatches) {
      expect(patch).not.toHaveProperty("inheritedGitContributorProfileIds");
    }
    expect(sessionStorePaths).toContain(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    );
  });

  it("uses the target agent workspace for cross-agent spawns", async () => {
    hoisted.configOverride = createCrossAgentConfig();

    await expectAcceptedWorkspace({
      agentId: "ops",
      expectedWorkspaceDir: "/tmp/workspace-ops",
    });
  });

  it("uses explicit cwd for cross-agent native subagent spawns without leaking it to Gateway params", async () => {
    hoisted.configOverride = createCrossAgentConfig();

    const result = await spawnSubagentDirect(
      {
        task: "inspect explicit cwd",
        agentId: "ops",
        cwd: "/tmp/requester-workspace",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: "/tmp/fallback-requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(getRegisteredRun()?.workspaceDir).toBe("/tmp/workspace-ops");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).not.toHaveProperty("workspaceDir");
  });

  it("rejects explicit cwd overrides for sandboxed native subagent spawns", async () => {
    hoisted.configOverride = createCrossAgentConfig();
    hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(({ sessionKey }) => ({
      sandboxed: typeof sessionKey === "string" && sessionKey.includes(":subagent:"),
    }));

    const result = await spawnSubagentDirect(
      {
        task: "inspect explicit cwd",
        agentId: "ops",
        cwd: "/tmp/requester-workspace",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: "/tmp/fallback-requester-workspace",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toContain("cwd override is not supported for sandboxed subagent runs");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  async function spawnAndReadAgentParams(task: { task: string; lightContext?: boolean }) {
    await spawnSubagentDirect(task, {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    });

    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    return agentCall?.params;
  }

  it("passes lightweight bootstrap context flags for lightContext subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
      lightContext: true,
    });

    expect(agentParams?.bootstrapContextMode).toBe("lightweight");
    expect(agentParams?.bootstrapContextRunKind).toBe("default");
  });

  it("omits bootstrap context flags for default subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
    });

    expect(agentParams).not.toHaveProperty("bootstrapContextMode");
    expect(agentParams).not.toHaveProperty("bootstrapContextRunKind");
  });

  it("deletes the provisional child session when a non-thread subagent start fails", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          throw new Error("spawn startup failed");
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after provisional session creation",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("spawn startup failed");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params?.key).toBe(result.childSessionKey);
    expect(deleteCall?.params?.deleteTranscript).toBe(true);
    expect(deleteCall?.params?.emitLifecycleHooks).toBe(false);
  });

  it("keeps lifecycle hooks enabled when registerSubagentRun fails after thread binding succeeds", async () => {
    hoisted.registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-thread-register-fail" };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after register with thread binding",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("Failed to register subagent run: registry unavailable");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(result.runId).toBe("run-thread-register-fail");

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params?.key).toBe(result.childSessionKey);
    expect(deleteCall?.params?.deleteTranscript).toBe(true);
    expect(deleteCall?.params?.emitLifecycleHooks).toBe(true);
  });
});
