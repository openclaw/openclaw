import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
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

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      loadSessionStoreMock,
      updateSessionStoreMock,
      registerSubagentRunMock,
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
    installSessionStoreCaptureMock(updateSessionStoreMock);
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    resolveSandboxRuntimeStatusMock.mockReset().mockReturnValue({ sandboxed: false });
    config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
      session: { threadBindings: { defaultSpawnContext: "isolated" } },
      agents: {
        list: [
          { id: "main", workspace: "/tmp/workspace-main", subagents: { allowAgents: ["ops"] } },
          { id: "ops", workspace: "/tmp/workspace-ops" },
        ],
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
        const store: Record<string, Record<string, unknown>> = {};
        await mutate(store);
        patches.push(...Object.values(store));
        return store;
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
    let store: Record<string, Record<string, unknown>> = {};
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (value) => {
        store = value;
      },
    });
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

  it("passes lightweight bootstrap flags", async () => {
    const result = await spawnSubagentDirect(
      { task: "inspect workspace", lightContext: true },
      context,
    );
    expect(result.status).toBe("accepted");
    expect(request("agent")?.params).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  });
});
