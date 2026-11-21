import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { readInProcessParticipationRun } from "../../../gateway/in-process-session-run.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { testing as cliBackendsTesting } from "../../cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../cli-runner.test-helpers.js";
import { harnessRegistry } from "../../model-catalog-fixtures.test-support.js";
import type { ParticipationCeiling } from "../../participation-ceiling.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const ceiling: ParticipationCeiling = {
  kind: "send",
  profileId: "invited-profile",
  sessionKey: fixture.parentSessionKey,
  permission: "read-only",
  tools: ["read"],
};

async function prepareParent() {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: fixture.parentSessionKey },
    {
      sessionId: "source-session",
      lifecycleRevision: "source-life",
      createdActor: { type: "human", source: "profile", id: "source-creator" },
    },
  );
  return {
    agentSessionKey: fixture.parentSessionKey,
    expectedParentSessionId: "source-session",
    participationCeiling: ceiling,
    sessionPermissionPolicy: { root: fixture.stateDir, mode: "read-only" as const },
    workspaceDir: fixture.stateDir,
    assertActive: vi.fn(),
  };
}

function useInProcessSpawns() {
  const dispatch = vi.fn(async <T>(method: string, params: Record<string, unknown>) => {
    if (method !== "agent") {
      throw new Error(`Unexpected spawn RPC ${method}`);
    }
    const child = loadSessionEntryReadOnly({
      agentId: "main",
      sessionKey: String(params.sessionKey),
    });
    expect(readInProcessParticipationRun(method, params)).toEqual(child?.participationCeiling);
    expect(params.participationCeiling).toBeUndefined();
    return { runId: params.idempotencyKey, status: "accepted" } as T;
  });
  spawnTesting.setDepsForTest({
    hasInProcessGatewayContext: () => true,
    resolveContextEngine: async () => new LegacyContextEngine(),
    dispatchGatewayMethodInProcess: dispatch,
  });
  return dispatch;
}

it("rejects participant tool routes before creating or dispatching a child", async () => {
  const context = await prepareParent();
  const dispatch = useInProcessSpawns();
  const callGateway = vi.fn(async () => {
    throw new Error("visible creation reached");
  });
  const tool = createSessionsSpawnTool({ ...context, config: getRuntimeConfig(), callGateway });
  for (const invalid of [
    { runtime: "acp" },
    { visible: true },
    { thread: true },
    { placement: { kind: "device", deviceId: "another-host" } },
    { placement: { kind: "profile", profileId: "cloud" } },
    { projectId: "different-project" },
    { worktree: true },
    { cwd: `${fixture.stateDir}/elsewhere` },
    { agentId: "other" },
  ]) {
    const result = await tool.execute("restricted-spawn", { task: "bounded helper", ...invalid });
    expect(result.details, JSON.stringify(invalid)).toMatchObject({ status: "forbidden" });
  }
  expect(dispatch).not.toHaveBeenCalled();
  expect(callGateway).not.toHaveBeenCalled();
  expect(context.assertActive).toHaveBeenCalled();
});

it("rejects a foreign swarm default and a resolved CLI before admission effects", async () => {
  const context = await prepareParent();
  const dispatch = useInProcessSpawns();
  const onSpawnEffectsStart = vi.fn();
  const cfg = getRuntimeConfig();
  await fixture.configure({
    ...cfg,
    tools: { ...cfg.tools, swarm: { enabled: true, defaultAgentId: "other" } },
    agents: {
      ...cfg.agents,
      ownership: "explicit",
      entries: {
        ...cfg.agents?.entries,
        other: { workspace: fixture.stateDir },
        main: { workspace: fixture.stateDir, subagents: { allowAgents: ["other"] } },
      },
    },
  });
  const foreign = await spawnSubagentDirect(
    { task: "bounded collector", collect: true, groupId: "participant-group" },
    { ...context, onSpawnEffectsStart },
  );
  expect(foreign).toMatchObject({ status: "forbidden" });
  expect(onSpawnEffectsStart).not.toHaveBeenCalled();
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: (() => [buildDefaultTestCliBackend()]) as never,
  });
  try {
    const cli = await spawnSubagentDirect(
      { task: "bounded helper", model: "test-cli/haiku" },
      { ...context, onSpawnEffectsStart },
    );
    expect(cli).toMatchObject({ status: "forbidden", error: expect.stringContaining("OpenClaw") });
    expect(onSpawnEffectsStart).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    cliBackendsTesting.resetDepsForTest();
  }
});

it("stamps the current cap at initial creation and keeps the original source on nested spawn", async () => {
  const context = await prepareParent();
  const dispatch = useInProcessSpawns();
  const tool = createSessionsSpawnTool({ ...context, config: getRuntimeConfig() });
  const first = await tool.execute("local-child", {
    task: "bounded helper",
    placement: { kind: "local" },
    context: "isolated",
    lightContext: true,
  });
  expect(first.details).toMatchObject({ status: "accepted" });
  const firstKey = (first.details as { childSessionKey: string }).childSessionKey;
  const child = loadSessionEntryReadOnly({ agentId: "main", sessionKey: firstKey });
  const source = {
    agentId: "main",
    sessionId: "source-session",
    lifecycleRevision: "source-life",
    creatorProfileId: "source-creator",
    root: fixture.stateDir,
  };
  expect(child).toMatchObject({
    inheritedToolPolicySource: "participant",
    sessionRoot: fixture.stateDir,
    spawnedCwd: fixture.stateDir,
    participationCeiling: { ...ceiling, source },
  });
  expect(child?.participationCeiling).toEqual({ ...ceiling, source });
  const nestedCeiling: ParticipationCeiling = { ...ceiling, source, tools: [] };
  const nested = await spawnSubagentDirect(
    { task: "narrower nested helper", context: "isolated", lightContext: true },
    {
      ...context,
      agentSessionKey: firstKey,
      expectedParentSessionId: child?.sessionId,
      participationCeiling: nestedCeiling,
    },
  );
  expect(nested).toMatchObject({ status: "accepted" });
  const grandchild = loadSessionEntryReadOnly({
    agentId: "main",
    sessionKey: nested.childSessionKey!,
  });
  expect(grandchild?.participationCeiling).toEqual(nestedCeiling);
  expect(grandchild?.sessionRoot).toBe(fixture.stateDir);
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it("rejects a resolved native harness before any child admission", async () => {
  const context = await prepareParent();
  const dispatch = useInProcessSpawns();
  const onSpawnEffectsStart = vi.fn();
  const cfg = getRuntimeConfig();
  await fixture.configure({
    ...cfg,
    plugins: { entries: { codex: { enabled: true } } },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
      },
    },
  });
  setActivePluginRegistry(harnessRegistry("codex"), "participation-spawn-native", "default");
  const result = await spawnSubagentDirect(
    { task: "bounded native helper" },
    { ...context, onSpawnEffectsStart },
  );
  expect(result).toMatchObject({ status: "forbidden", error: expect.stringContaining("OpenClaw") });
  expect(onSpawnEffectsStart).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

it("refuses a stale host invocation before it captures or creates a child", async () => {
  const context = await prepareParent();
  const dispatch = useInProcessSpawns();
  const tool = createSessionsSpawnTool({
    ...context,
    assertActive() {
      throw new Error("source turn closed");
    },
  });
  await expect(tool.execute("stale-child", { task: "must not run" })).rejects.toThrow(
    "source turn closed",
  );
  expect(dispatch).not.toHaveBeenCalled();
});
