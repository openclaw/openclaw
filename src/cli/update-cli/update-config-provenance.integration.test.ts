// Real config IO; update packages, provider authentication, and host actions are stubbed.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountListHelpers } from "../../channels/plugins/account-helpers.js";
import * as legacyBindingRepair from "../../commands/doctor/shared/legacy-config-binding-repair.runtime.js";
import type { runPostCorePluginConvergence as Converge } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import * as configIO from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV } from "../../infra/update-post-core-context.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as pluginModuleLoader from "../../plugins/plugin-module-loader-cache.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as channelFixtures from "../../test-utils/channel-plugins.js";
import { pluginSyncResult, postCoreConvergenceResult } from "./update-cli-config.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";

const controls = vi.hoisted(() => ({ root: "" }));
function manifest() {
  return {
    plugins: [createPluginManifestRecordFixture({ id: "discord", channels: ["discord"] })],
    diagnostics: [],
  };
}

// mock-isolation: Use a synthetic plugin inventory instead of scanning installed plugins.
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => manifest(),
}));
vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => manifest(),
}));
vi.mock("../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: (config: OpenClawConfig) => ({ config, changes: [] }),
}));
// mock-isolation: Model cohort config mutations without installing plugin packages.
vi.mock("../../plugins/update-cohort.js", () => ({
  convergePluginReleaseCohort: async ({ config }: { config: OpenClawConfig }) => {
    vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
    return {
      config: { ...config, gateway: { ...config.gateway, port: 19001 } },
      changed: true,
      sync: pluginSyncResult(config),
      missingPayloads: [],
      remainingMissingPayloads: [],
      repairedMissingPayloadIds: new Set(),
      repairOutcomes: [],
      updateOutcomes: [],
      npmChanged: false,
    };
  },
}));
// mock-isolation: Keep post-core convergence inside the provenance fixture.
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: async ({
    cfg,
  }: Parameters<typeof Converge>[0]): ReturnType<typeof Converge> => ({
    config: cfg,
    ...postCoreConvergenceResult(),
  }),
}));
vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(),
}));
vi.mock("../../plugins/location-bridges.js", () => ({
  listPersistedBundledPluginLocationBridges: async () => [],
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: async () => "2026.9.2",
  resolveUpdateRoot: async () => controls.root,
}));
vi.mock("./update-command-fresh-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(async () => {}),
  completePostCorePluginUpdate: async ({ pluginUpdate }: { pluginUpdate: unknown }) => ({
    pluginUpdate,
    configSnapshot: await configIO.readConfigFileSnapshot(),
  }),
}));

import {
  planLegacyConfigForUpdateChannel,
  repairLegacyConfigForUpdateChannel,
} from "../../commands/doctor/legacy-config-repair.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const bindingRepairRuntimePath = fileURLToPath(
  new URL("../../commands/doctor/shared/legacy-config-binding-repair.runtime.ts", import.meta.url),
);

let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
beforeEach(() => {
  const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
  // Keep the real repair in the same graph as this fixture's channel registry.
  vi.spyOn(pluginModuleLoader, "getCachedPluginModuleLoader").mockImplementation((options) =>
    options.modulePath === bindingRepairRuntimePath
      ? () => legacyBindingRepair
      : loadModule(options),
  );
  previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(
    channelFixtures.createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: channelFixtures.createChannelTestPluginBase({
          id: "discord",
          config: createAccountListHelpers("discord"),
        }),
      },
    ]),
  );
});

afterEach(() => {
  setActivePluginRegistry(previousRegistry ?? channelFixtures.createTestRegistry());
  closeOpenClawStateDatabaseForTest();
  configIO.resetConfigRuntimeState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const narrowerRoute = {
  agentId: "research",
  match: { channel: "discord", peer: { kind: "direct", id: "research-user" } },
};
const accounts = { discord: { accounts: { default: {} } } };

async function prepareConfig(home: string, config: Record<string, unknown>) {
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const original = JSON.stringify(config);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, original);
  configIO.resetConfigRuntimeState();
  const prepared = await configIO
    .createConfigIO({ pluginValidation: "skip" })
    .readConfigFileSnapshotForWrite();
  return { ...prepared, configPath, original };
}

it("reports unresolved ownership without writing when the original roster is unavailable", async () => {
  await withTempHome(async (home) => {
    const { snapshot, writeOptions, configPath, original } = await prepareConfig(home, {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      channels: accounts,
      bindings: [narrowerRoute],
    });
    const result = await repairLegacyConfigForUpdateChannel({
      configSnapshot: { ...snapshot, sourceConfigBeforeMigrations: undefined },
      configWriteOptions: writeOptions,
      jsonMode: true,
    });
    expect(result.repaired).toBe(false);
    for (const detail of [
      "unresolved: original roster unavailable",
      '{"agentId":"<agentId>","match":{"channel":"discord","accountId":"default"}}',
    ]) {
      expect(result.warnings).toEqual([expect.stringContaining(detail)]);
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });
});

it("preserves the historical account owner and narrower route through update channel repair", async () => {
  await withTempHome(async (home) => {
    const { snapshot, writeOptions, configPath } = await prepareConfig(home, {
      gateway: { mode: "local", bind: "localhost" },
      agents: { list: [{ id: "ops" }, { id: "research" }] },
      channels: accounts,
      bindings: [narrowerRoute],
    });
    expect(snapshot.sourceConfigBeforeMigrations).toHaveProperty("agents.list", [
      { id: "ops" },
      { id: "research" },
    ]);
    const plan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
    expect(plan).toBeDefined();
    await repairLegacyConfigForUpdateChannel({
      configSnapshot: snapshot,
      plan,
      configWriteOptions: writeOptions,
      jsonMode: true,
    });
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(persisted.bindings).toEqual([
      narrowerRoute,
      { agentId: "ops", match: { channel: "discord", accountId: "default" } },
      { agentId: "ops", match: { channel: "discord", accountId: "*" } },
    ]);
  });
});

it.each([
  { flow: "plugins", requestedChannel: undefined },
  { flow: "legacy", requestedChannel: undefined },
  ...["converge", "resume", "finalize"].flatMap((flow) =>
    [undefined, "beta" as const].map((requestedChannel) => ({ flow, requestedChannel })),
  ),
])(
  "retains env refs through $flow (channel: $requestedChannel)",
  async ({ flow, requestedChannel }) => {
    await withTempHome(async (home) => {
      controls.root = home;
      vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-before");
      vi.stubEnv(POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV, requestedChannel);
      const prepared = await prepareConfig(home, {
        gateway: {
          mode: "local",
          ...(flow === "legacy" ? { bind: "localhost" } : {}),
          auth: { mode: "token", token: "${UPDATE_PROVENANCE_TOKEN}" },
        },
      });
      const { configPath, snapshot: configSnapshot, writeOptions: configWriteOptions } = prepared;
      const configInput = { configSnapshot, configWriteOptions };
      const updateInput = { root: home, channel: "stable" as const };
      expect(prepared.snapshot.sourceConfig.gateway?.auth?.token).toBe("synthetic-before");
      if (flow === "plugins") {
        expect(prepared.snapshot.valid).toBe(true);
        await updatePluginsAfterCoreUpdate({
          ...updateInput,
          ...configInput,
          timeoutMs: 1000,
          json: true,
          pluginInstallRecords: {},
        });
      } else if (flow === "legacy") {
        vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
        const result = await repairLegacyConfigForUpdateChannel({
          ...configInput,
          jsonMode: true,
        });
        expect(result.repaired).toBe(true);
      } else if (flow === "converge") {
        const env = { ...process.env };
        const { runId } = createUpdateRun({ trigger: "cli" }, { env });
        await withUpdateCommandExecutor(runId, async (executor) =>
          convergeUpdatePlugins({
            coreAlreadyCurrent: true,
            candidateRuntime: true,
            result: resultFixture(home, {
              mode: "git",
              before: { sha: "same", version: "2026.9.2" },
              after: { sha: "same", version: "2026.9.2" },
            }),
            ...updateInput,
            configSnapshot,
            installKindChanged: false,
            requestedChannel: requestedChannel ?? null,
            storedChannel: null,
            downgradeRisk: false,
            opts: { json: true, run: { runId, env, executorFence: await executor.enter(home) } },
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            updateStepTimeoutMs: 1000,
          }),
        );
      } else if (flow === "resume") {
        // The real exit is a process boundary, not part of config persistence.
        vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
        vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        await resumePostCoreUpdate({
          ...updateInput,
          opts: { json: true },
          timeoutMs: 1000,
        });
      } else {
        vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        await updateFinalizeCommand({
          channel: requestedChannel,
          json: true,
          deferCompletionCache: true,
        });
      }
      const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(saved.gateway).toMatchObject({
        auth: { token: "${UPDATE_PROVENANCE_TOKEN}" },
        ...(flow === "legacy" ? { bind: "loopback" } : { port: 19001 }),
      });
      expect(saved.update?.channel).toBe(requestedChannel);
      const after = await configIO.readConfigFileSnapshot();
      expect(after.sourceConfig.gateway?.auth?.token).toBe("synthetic-after");
    });
  },
);
