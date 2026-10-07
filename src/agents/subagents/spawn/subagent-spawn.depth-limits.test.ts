import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
let config = createSubagentSpawnTestConfig();
let depth = 0;
let activeChildren = 0;
let store: Record<string, Record<string, unknown>> = {};
let spawn: typeof import("./subagent-spawn.js").spawnSubagentDirect;
const parentKey = "agent:main:subagent:parent";

function limits(subagents: Record<string, unknown>) {
  config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: { defaults: { workspace: "/tmp/workspace-main", subagents } },
  });
}

async function spawnChild(params: Parameters<typeof spawn>[0] = { task: "hello" }) {
  return spawn(params, { agentSessionKey: parentKey, workspaceDir: "/tmp/workspace-main" });
}

function child(result: Awaited<ReturnType<typeof spawn>>) {
  expect(result.status).toBe("accepted");
  expect(result.runId).toBe("run-1");
  expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
  const entry = store[result.childSessionKey!];
  expect(entry).toBeDefined();
  return entry!;
}

describe("subagent spawn depth and child limits", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect: spawn } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      registerSubagentRunMock,
      updateSessionStoreMock,
      loadSessionStoreMock: () => ({ [parentKey]: { sessionId: "nested-parent", updatedAt: 1 } }),
      getSubagentDepthFromSessionStore: (sessionKey) => (sessionKey === parentKey ? depth : 0),
      countActiveRunsForSession: (sessionKey) => (sessionKey === parentKey ? activeChildren : 0),
      resetModules: false,
    }));
  });
  beforeEach(() => {
    depth = 0;
    activeChildren = 0;
    store = {};
    vi.clearAllMocks();
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (value) => {
        store = value;
      },
    });
    config = createSubagentSpawnTestConfig("/tmp/workspace-main");
    setupAcceptedSubagentGatewayMock(callGatewayMock);
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

  it("persists inherited tool denies on spawned child sessions", async () => {
    limits({ maxSpawnDepth: 2 });
    const result = await spawn(
      { task: "hello" },
      {
        agentSessionKey: "agent:main:main",
        workspaceDir: "/tmp/workspace-main",
        inheritedToolAllowlist: ["sessions_spawn", "read", ""],
        inheritedToolDenylist: ["bash", "exec", "read", ""],
      },
    );
    expect(child(result)).toMatchObject({
      inheritedToolAllow: ["sessions_spawn", "read"],
      inheritedToolDeny: ["exec", "read"],
      inheritedToolPolicyVersion: 1,
    });
  });
});
