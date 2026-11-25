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
import { captureQueuedOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { testing as cliBackendsTesting } from "../../cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../cli-runner.test-helpers.js";
import { harnessRegistry } from "../../model-catalog-fixtures.test-support.js";
import type { ParticipationCeiling } from "../../participation-ceiling.js";
import { createParticipationTestAuthority } from "../../participation-ceiling.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const ceiling = {
  kind: "send",
  profileId: "invited-profile",
  sessionKey: fixture.parentSessionKey,
  permission: "read-only",
  tools: ["read"],
} satisfies Omit<ParticipationCeiling, "source">;

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
    operatorAuthority: participantAuthority(),
    sessionPermissionPolicy: { root: fixture.stateDir, mode: "read-only" as const },
    workspaceDir: fixture.stateDir,
    assertActive: vi.fn(),
  };
}

function participantAuthority(permission: "read-only" | "workspace" = "read-only") {
  const participationCeiling = {
    ...ceiling,
    permission,
    tools: ["read"],
    source: {
      agentId: "main",
      sessionId: "source-session",
      lifecycleRevision: "source-life",
      creatorProfileId: "source-creator",
      root: fixture.stateDir,
    },
  };
  return createParticipationTestAuthority(participationCeiling, ["operator.write"]);
}

function runAsParticipant<T>(
  context: Pick<Awaited<ReturnType<typeof prepareParent>>, "agentSessionKey" | "operatorAuthority">,
  run: () => Promise<T>,
): Promise<T> {
  return withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: context.agentSessionKey,
      operatorAuthority: context.operatorAuthority,
    },
    run,
  );
}

function useInProcessSpawns() {
  const dispatch = vi.fn(async (method: string, params: Record<string, unknown>) => {
    throw new Error(`Unexpected participant dispatch ${method}: ${String(params.sessionKey)}`);
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
  const { operatorAuthority: _authority, ...options } = context;
  const tool = createSessionsSpawnTool({ ...options, config: getRuntimeConfig(), callGateway });
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
    const result = await runAsParticipant(context, () =>
      tool.execute("restricted-spawn", { task: "bounded helper", ...invalid }),
    );
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
  const foreign = await runAsParticipant(context, () =>
    spawnSubagentDirect(
      { task: "bounded collector", collect: true, groupId: "participant-group" },
      { ...context, onSpawnEffectsStart },
    ),
  );
  expect(foreign).toMatchObject({ status: "forbidden" });
  expect(onSpawnEffectsStart).not.toHaveBeenCalled();
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: (() => [buildDefaultTestCliBackend()]) as never,
  });
  try {
    const cli = await runAsParticipant(context, () =>
      spawnSubagentDirect(
        { task: "bounded helper", model: "test-cli/haiku" },
        { ...context, onSpawnEffectsStart },
      ),
    );
    expect(cli).toMatchObject({ status: "forbidden", error: expect.stringContaining("OpenClaw") });
    expect(onSpawnEffectsStart).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    cliBackendsTesting.resetDepsForTest();
  }
});

it.each(["on-miss", "off"] as const)(
  "derives matching admitted and recovery restrictions before reserving a %s helper",
  async (ask) => {
    const context = {
      ...(await prepareParent()),
      operatorAuthority: participantAuthority("workspace"),
      sessionPermissionPolicy: {
        root: fixture.stateDir,
        mode: "guarded" as const,
        execPolicy: { security: "allowlist" as const, ask },
      },
    };
    useInProcessSpawns();
    const result = await runAsParticipant(context, () =>
      resolveSubagentSpawnRequest(
        { task: "bounded helper", context: "isolated", lightContext: true },
        context,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.result.error);
    }
    // Release the request's unlaunched admission; this boundary proof never dispatches a model.
    result.resolved.admissionReservation?.release();
    const authority = result.resolved.gateway.operatorAuthority!;
    expect(authority.participationCeiling).toMatchObject({
      permission: "guarded",
      execPolicy: { security: "allowlist", ask },
      source: { root: fixture.stateDir },
    });
    const captured = captureQueuedOperatorRecoverySource(authority);
    expect(captured?.kind).toBe("gateway");
    expect(
      captured?.kind === "gateway" ? captured.snapshot.participationCeiling : undefined,
    ).toEqual(authority.participationCeiling);
    expect(context.operatorAuthority.participationCeiling?.permission).toBe("workspace");
    expect(
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: result.resolved.participationChildPlan!.resolved.childSessionKey,
      }),
    ).toBeUndefined();
  },
);

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
  const result = await runAsParticipant(context, () =>
    spawnSubagentDirect({ task: "bounded native helper" }, { ...context, onSpawnEffectsStart }),
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
