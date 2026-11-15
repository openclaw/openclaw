// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  baseParams,
  type CommitTransform,
  codexPluginMetadataSnapshot,
  committed,
  getSetupApplyMocks,
  mainAgentModelConfig,
  materializePluginDefaults,
  runtime,
  resetSetupApplyMocks,
  setSetupCommitState,
  snapshot,
  snapshotSequence,
  transformAttempt,
} from "./setup-apply.test-harness.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import * as configModule from "../config/config.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { projectInferenceRoute } from "./inference-route.js";
import { applySystemAgentSetup } from "./setup-apply.js";

const mocks = getSetupApplyMocks();
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspace = "/tmp/openclaw-workspace";
const firstTeam = { name: "coordinator", team: true };
const hashChanged = "config changed while AI access was being tested";
const workspaceChanged = "Another onboarding run owns a different workspace";
const routeChanged = "changed before setup could start";
const apply = (
  overrides: Parameters<typeof baseParams>[0] = {},
  hooks?: Parameters<typeof applySystemAgentSetup>[1],
) => applySystemAgentSetup(baseParams(overrides), hooks);
async function reject(
  overrides: Parameters<typeof baseParams>[0],
  error: string,
  untouched: Array<"commit" | "ensureWorkspace" | "ensureOnboardingAgent"> = [],
  unpublished = false,
) {
  await expect(apply(overrides)).rejects.toThrow(error);
  for (const effect of untouched) {
    expect(mocks[effect]).not.toHaveBeenCalled();
  }
  if (unpublished) {
    expect(mocks.state.persistedConfig).toBeUndefined();
  }
}
const expectWorkspace = (directory = workspace, agentId = "main") =>
  expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
    directory,
    runtime,
    expect.objectContaining({ agentId }),
  );
function start(config = mainAgentModelConfig(), hash: string | null = "probe", source = config) {
  const initial = snapshot(
    hash,
    source,
    materializeRuntimeConfig(config, { manifestRegistry: { plugins: [] } }),
  );
  setSetupCommitState(source, initial);
  return initial;
}
function startAbsent() {
  start({ agents: { entries: { main: {} } } }, null, {});
  mocks.state.commitPreviousHash = null;
}
function agentConfig(agentDir: string): OpenClawConfig {
  return { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { agentDir } } } };
}
function persistedReads(
  initial: ReturnType<typeof snapshot>,
  materialize: (config: OpenClawConfig) => OpenClawConfig,
) {
  const persisted = () => {
    const config = mocks.state.persistedConfig ?? initial.sourceConfig;
    return snapshot("persisted", config, materialize(config));
  };
  mocks.readVerifiedSnapshot.mockImplementation(snapshotSequence(initial, initial, persisted));
  return persisted;
}

describe("applySystemAgentSetup transaction boundaries", () => {
  beforeEach(resetSetupApplyMocks);

  it("rejects a config created after the initial inference check before writing", async () => {
    mocks.state.initialSnapshot = snapshot("present", {}, { agents: { entries: { main: {} } } });

    await reject({ expectedConfigHash: null }, hashChanged, ["commit", "ensureWorkspace"], true);
  });

  it("preserves the pre-roster verified route while creating a team", async () => {
    const runtimeConfig = agentConfig("/agents/main");
    const initial = start(runtimeConfig, "probe", {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    mocks.readVerifiedSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
    await apply({
      expectedConfigHash: "probe",
      expectedInferenceRoute: await projectInferenceRoute(initial.config),
      firstAgent: firstTeam,
    });
    expect(mocks.state.persistedConfig?.agents?.entries).toHaveProperty("coordinator");
    expectWorkspace(`${workspace}/coordinator`, "coordinator");
    expect(mocks.state.persistedConfig?.agents?.entries).not.toHaveProperty("main");
  });

  it("reports an existing roster instead of silently skipping the requested first team", async () => {
    await reject(
      { firstAgent: firstTeam },
      "The requested team was not created because an agent roster already exists",
      ["ensureOnboardingAgent", "commit", "ensureWorkspace"],
    );
  });

  it("refuses a damaged pinned team before publishing setup configuration", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { workspace, systemAgent: { agentId: "coordinator" } },
        entries: {
          coordinator: { workspace },
          researcher: { workspace: path.join(workspace, "researcher") },
        },
      },
    } satisfies OpenClawConfig;
    start(config);
    await reject(
      { workspace, teamCoordinatorId: "coordinator", assertCommitPreconditions: () => {} },
      workspaceChanged,
      ["ensureOnboardingAgent", "ensureWorkspace"],
      true,
    );
  });

  it("rejects a specialist workspace outside the team receipt before committing setup", async () => {
    startAbsent();
    await reject(
      {
        firstAgent: firstTeam,
        assertCommitPreconditions: () => {},
        finalizeConfig: (config) => ({
          ...config,
          agents: {
            ...config.agents,
            entries: {
              ...config.agents?.entries,
              writer: { ...config.agents?.entries?.writer, workspace: "/tmp/other-workspace" },
            },
          },
        }),
      },
      workspaceChanged,
      ["ensureWorkspace"],
    );

    expect(mocks.events).toEqual(["agent-create"]);
  });

  it("preserves a configured workspace with existing state and no authored roster", async () => {
    const stateDir = testTempDirs.make("openclaw-setup-state-");
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const sourceConfig: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            workspace: "/tmp/current-workspace",
          },
        },
      };
      const runtimeConfig: OpenClawConfig = {
        agents: { ...agentConfig("/agents/main").agents, defaults: sourceConfig.agents?.defaults },
      };
      start(structuredClone(runtimeConfig), "probe", sourceConfig);
      await apply({
        workspace: "/tmp/requested-workspace",
        assertCommitPreconditions: () => {},
      });
      expect(mocks.state.persistedConfig?.agents).toMatchObject({
        defaults: { workspace: "/tmp/current-workspace" },
        entries: { main: { workspace: "/tmp/current-workspace" } },
      });
      expectWorkspace("/tmp/current-workspace");
    });
  });

  it("rejects invalid config before any setup mutation", async () => {
    mocks.state.initialSnapshot = {
      ...snapshot("invalid", {}),
      valid: false,
      issues: [{ path: "agents", message: "bad agent config" }],
    };

    await reject({}, "bad agent config", ["commit", "ensureWorkspace"]);
  });

  it("rejects the reserved user agent id case-insensitively", async () => {
    const config: OpenClawConfig = {
      agents: { ...mainAgentModelConfig().agents, entries: { OpenClaw: {} } },
    };
    mocks.state.initialSnapshot = snapshot("reserved", config);

    await reject({}, 'Agent id "openclaw" is reserved', ["commit"]);
  });

  it("rechecks the probed revision inside the final transform", async () => {
    mocks.state.commitPreviousHash = "concurrent";

    await reject({ expectedConfigHash: "probe" }, hashChanged, ["ensureWorkspace"], true);
  });

  it.each([
    ["default agent", "openai/gpt-5.5", "other", undefined],
    ["default model", "anthropic/claude-opus-4-6", "main", undefined],
    ["agent credential location", "openai/gpt-5.5", "main", "/agents/moved"],
  ] as const)(
    "rechecks the probed %s inside the final transform",
    async (_name, model, agentId, agentDir) => {
      const initial = mocks.state.initialSnapshot;
      const runtimeConfig = {
        agents: {
          defaults: { model: { primary: model } },
          entries: { [agentId]: agentDir ? { agentDir } : {} },
        },
      };
      if (agentDir) {
        mocks.state.commitConfig = runtimeConfig;
      }
      mocks.state.commitSnapshot = snapshot("probe", runtimeConfig);
      mocks.readVerifiedSnapshot.mockImplementation(
        snapshotSequence(initial, mocks.state.commitSnapshot),
      );
      await reject(
        {
          expectedConfigHash: "probe",
          expectedInferenceRoute: await projectInferenceRoute(initial.config),
        },
        routeChanged,
        [],
        true,
      );
    },
  );
  it.each(["route", "resolved source"])(
    "rejects %s drift before opening the transaction",
    async (kind) => {
      const source = {
        ...mainAgentModelConfig(),
        ...(kind === "resolved source" ? { gateway: { port: 18789 } } : {}),
      };
      const current = kind === "route" ? source : { ...source, gateway: { port: 19000 } };
      const verified =
        kind === "route" ? mainAgentModelConfig("anthropic/claude-opus-4-8") : current;
      mocks.state.initialSnapshot = snapshot("probe", source);
      mocks.readVerifiedSnapshot.mockResolvedValue(snapshot("probe", current));
      await reject(
        { expectedInferenceRoute: await projectInferenceRoute(snapshot("probe", verified).config) },
        routeChanged,
        ["commit"],
      );
    },
  );

  it("rejects a setup candidate that changes the exact verified route identity", async () => {
    const initial = mainAgentModelConfig();
    const initialSnapshot = start(initial);
    mocks.readVerifiedSnapshot.mockResolvedValue(initialSnapshot);

    await reject(
      {
        finalizeConfig: () => mainAgentModelConfig("anthropic/claude-opus-4-8"),
        expectedInferenceRoute: await projectInferenceRoute(initialSnapshot.config),
      },
      "no longer preserves the exact verified inference route",
      ["ensureWorkspace"],
      true,
    );
  });

  it("rebuilds Gateway settings from the snapshot that wins a transaction retry", async () => {
    const initial = {
      ...mainAgentModelConfig(),
      gateway: {
        port: 18789,
        bind: "loopback",
        auth: { mode: "token", token: "initial-token" },
      },
    } satisfies OpenClawConfig;
    const concurrent = {
      ...initial,
      logging: { level: "debug" },
      gateway: {
        ...initial.gateway,
        port: 19000,
        bind: "lan",
        auth: { mode: "token" as const, token: "concurrent-token" },
      },
    } satisfies OpenClawConfig;
    const initialSnapshot = start(initial, "hash-1");
    const concurrentSnapshot = snapshot("hash-2", concurrent);
    const persisted = () => snapshot("persisted", mocks.state.persistedConfig ?? concurrent);
    mocks.readSnapshot.mockImplementation(snapshotSequence(initialSnapshot, persisted));
    mocks.readVerifiedSnapshot.mockImplementation(
      snapshotSequence(initialSnapshot, initialSnapshot, concurrentSnapshot, persisted),
    );
    mocks.commit.mockImplementationOnce(async (params: { transform: CommitTransform }) => {
      await transformAttempt(params.transform, initialSnapshot);
      const result = await transformAttempt(params.transform, concurrentSnapshot, 1);
      mocks.events.push("commit");
      return committed(result, "hash-2");
    });
    const expectedInferenceRoute = await projectInferenceRoute(initialSnapshot.config);

    await apply({ expectedInferenceRoute, surface: "cli" });

    expect(mocks.state.persistedConfig?.logging).toEqual({ level: "debug" });
    expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          port: 19000,
          bind: "lan",
          gatewayToken: "concurrent-token",
        }),
      }),
    );
  });

  it("revalidates the verified route after the config write", async () => {
    const initial = mainAgentModelConfig();
    const drifted = mainAgentModelConfig("anthropic/claude-opus-4-8");
    const initialSnapshot = start(initial);
    const driftedSnapshot = snapshot("persisted", drifted);
    const fallback = () => mocks.state.initialSnapshot;
    mocks.readSnapshot.mockImplementation(
      snapshotSequence(initialSnapshot, driftedSnapshot, fallback),
    );
    mocks.readVerifiedSnapshot.mockImplementation(
      snapshotSequence(initialSnapshot, initialSnapshot, driftedSnapshot, fallback),
    );
    mocks.commit.mockImplementationOnce(async (params: { transform: CommitTransform }) => {
      const result = await transformAttempt(params.transform, initialSnapshot);
      return committed(result, "probe", drifted);
    });

    await reject(
      { expectedInferenceRoute: await projectInferenceRoute(initialSnapshot.config) },
      "changed after the config write",
    );

    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("accepts persisted plugin defaults that match the verified runtime route", async () => {
    const pluginMetadataSnapshot = codexPluginMetadataSnapshot("agent");
    const sourceConfig = {
      ...mainAgentModelConfig(),
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { transport: "stdio", homeScope: "agent" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const initialSnapshot = snapshot(
      "probe",
      sourceConfig,
      materializePluginDefaults(sourceConfig, pluginMetadataSnapshot),
    );
    setSetupCommitState(sourceConfig, initialSnapshot);
    const persistedSnapshot = persistedReads(initialSnapshot, (config) =>
      materializePluginDefaults(config, pluginMetadataSnapshot),
    );
    mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
      snapshot: persistedSnapshot(),
      pluginMetadataSnapshot,
    }));
    await apply({
      expectedInferenceRoute: await projectInferenceRoute(initialSnapshot.config),
    });

    expect(mocks.ensureWorkspace).toHaveBeenCalledOnce();
  });

  it("rejects a materialized route that differs from the inference proof", async () => {
    const sourceConfig = mainAgentModelConfig();
    const materializedConfig = mainAgentModelConfig("anthropic/claude-opus-4-8");
    const verifiedSnapshot = start(sourceConfig);
    const persistedSnapshot = persistedReads(verifiedSnapshot, () => materializedConfig);
    mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
      snapshot: persistedSnapshot(),
    }));
    const validate = vi
      .spyOn(configModule, "validateConfigObjectWithPlugins")
      .mockReturnValue({ ok: true, config: materializedConfig, warnings: [] });

    try {
      await reject(
        { expectedInferenceRoute: await projectInferenceRoute(verifiedSnapshot.config) },
        "materialized inference route",
      );
    } finally {
      validate.mockRestore();
    }

    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("returns visible post-commit workspace, approval, and service failures", async () => {
    mocks.ensureWorkspace.mockRejectedValueOnce(new Error("workspace exploded"));
    mocks.updateExecApprovals.mockRejectedValueOnce(new Error("approval exploded"));
    mocks.ensureGatewayService.mockRejectedValueOnce(new Error("service exploded"));

    const result = await apply({ expectedConfigHash: "probe", surface: "cli" });

    expect(mocks.events).toEqual(["commit"]);
    expect(result).toMatchObject({
      lines: expect.arrayContaining([
        "Workspace files: workspace exploded",
        "OpenClaw exec approval: approval exploded; local model harnesses may ask again.",
        "Gateway service: service exploded",
      ]),
      workspaceReady: false,
    });
    expect(result.gateway).toEqual({ status: "failed", error: "service exploded" });
  });

  it.each([
    { status: "failed", error: "gateway install blocked" } as const,
    { status: "skipped", reason: "external" } as const,
  ])("preserves the service owner's $status outcome after config commits", async (gateway) => {
    mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });
    const result = await apply({ surface: "cli" });
    const marker = gateway.status === "failed" ? gateway.error : "SUPERVISOR_MODE=external";
    expect(result.gateway).toEqual(gateway);
    expect(result.lines.join("\n")).toContain(marker);
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it("reports explicitly skipped service installation", async () => {
    const gateway = { status: "skipped", reason: "explicit" };
    mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });
    const result = await apply({ surface: "cli", installDaemon: false });

    expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { installDaemon: false } }),
    );
    expect(result.gateway).toEqual(gateway);
    expect(result.lines).toContain(
      "Gateway: service installation skipped. Run `openclaw gateway run` to start it in the foreground.",
    );
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)(
    "uses the %s readiness budget after service installation",
    async (platform) => {
      await withMockedPlatform(platform, async () => {
        const gateway = { status: "ready", action: "installed" } as const;
        mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });

        const result = await apply({ surface: "cli" });

        expect(result.gateway).toEqual(gateway);
        expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith(
          expect.objectContaining(resolveGatewayStartupTiming(platform)),
        );
      });
    },
  );

  it("keeps setup incomplete when the installed gateway never becomes reachable", async () => {
    mocks.ensureGatewayService.mockResolvedValueOnce({
      gateway: { status: "ready", action: "installed" },
      containerWithoutUserSystemd: false,
    });
    mocks.waitForGatewayReachable.mockResolvedValueOnce({
      ok: false,
      detail: "connection refused",
    });

    const result = await apply({ surface: "cli" });

    expect(result.gateway).toEqual({
      status: "failed",
      error: "Gateway is not reachable yet (connection refused).",
    });
    expect(result.lines).toContain(
      "Gateway: not reachable yet (connection refused) — say `gateway status` to check",
    );
  });

  it("authenticates non-restarting trusted-proxy Gateway recovery with its password SecretRef", async () => {
    const auth = {
      mode: "trusted-proxy" as const,
      trustedProxy: { userHeader: "x-forwarded-user" },
      password: { source: "env" as const, provider: "default", id: "SETUP_TEST_PASSWORD" },
    };
    const config: OpenClawConfig = {
      ...mainAgentModelConfig(),
      gateway: {
        auth,
        trustedProxies: ["10.0.0.5"],
      },
    };
    start(config);
    mocks.ensureGatewayService.mockResolvedValueOnce({
      gateway: { status: "ready", action: "reused" },
      containerWithoutUserSystemd: false,
    });

    await withEnvAsync(
      {
        SETUP_TEST_PASSWORD: "resolved-password",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const result = await apply({ surface: "cli", resume: true });

        expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
          expect.objectContaining({ loadedAction: "resume" }),
        );
        expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith({
          url: "ws://127.0.0.1:18789",
          token: undefined,
          password: "resolved-password",
          deadlineMs: 15_000,
        });
        expect(mocks.state.persistedConfig?.gateway?.auth).toEqual(auth);
        expect(result.gateway).toEqual({ status: "ready", action: "reused" });
        expect(result.workspaceReady).toBe(true);
      },
    );
  });
});
