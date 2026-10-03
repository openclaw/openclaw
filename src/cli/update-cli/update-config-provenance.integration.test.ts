// Real config IO; update packages, provider authentication, and host actions are stubbed.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountListHelpers } from "../../channels/plugins/account-helpers.js";
import * as legacyBindingRepair from "../../commands/doctor/shared/legacy-config-binding-repair.runtime.js";
import type { runPostCorePluginConvergence } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { replaceConfigFile } from "../../config/config.js";
import {
  createConfigIO,
  readConfigFileSnapshot,
  resetConfigRuntimeState,
} from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV } from "../../infra/update-post-core-context.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as pluginModuleLoader from "../../plugins/plugin-module-loader-cache.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const controls = vi.hoisted(() => ({ root: "" }));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({
    plugins: [createPluginManifestRecordFixture({ id: "discord", channels: ["discord"] })],
    diagnostics: [],
  }),
}));
vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({
    plugins: [createPluginManifestRecordFixture({ id: "discord", channels: ["discord"] })],
    diagnostics: [],
  }),
}));
vi.mock("../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: (config: OpenClawConfig) => ({ config, changes: [] }),
}));
vi.mock("../../plugins/update-cohort.js", () => ({
  convergePluginReleaseCohort: async ({ config }: { config: OpenClawConfig }) => {
    vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
    return {
      config: { ...config, gateway: { ...config.gateway, port: 19001 } },
      changed: true,
      sync: {
        changed: false,
        summary: { errors: [], warnings: [], switchedToBundled: [], switchedToNpm: [] },
      },
      missingPayloads: [],
      remainingMissingPayloads: [],
      repairedMissingPayloadIds: new Set(),
      repairOutcomes: [],
      updateOutcomes: [],
      npmChanged: false,
    };
  },
}));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: async ({
    cfg,
  }: Parameters<typeof runPostCorePluginConvergence>[0]): ReturnType<
    typeof runPostCorePluginConvergence
  > => ({
    config: cfg,
    configChanges: [],
    installedPluginIdRecovery: new Map(),
    changes: [],
    warnings: [],
    installRecords: {},
    smokeFailures: [],
    errored: false,
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
    configSnapshot: await readConfigFileSnapshot(),
  }),
}));

import {
  planLegacyConfigForUpdateChannel,
  repairLegacyConfigForUpdateChannel,
} from "../../commands/doctor/legacy-config-repair.js";
import { applyLegacyCompatibilityStep } from "../../commands/doctor/shared/config-flow-steps.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
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
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: createChannelTestPluginBase({
          id: "discord",
          config: createAccountListHelpers("discord"),
        }),
      },
    ]),
  );
});

afterEach(() => {
  setActivePluginRegistry(previousRegistry ?? createTestRegistry());
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("update config provenance", () => {
  it("reports unresolved ownership without writing when the original roster is unavailable", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const original = JSON.stringify({
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        channels: { discord: { accounts: { default: {} } } },
        bindings: [
          {
            agentId: "research",
            match: { channel: "discord", peer: { kind: "direct", id: "research-user" } },
          },
        ],
      });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, original);
      resetConfigRuntimeState();
      const { snapshot, writeOptions } = await createConfigIO({
        pluginValidation: "skip",
      }).readConfigFileSnapshotForWrite();
      const result = await repairLegacyConfigForUpdateChannel({
        configSnapshot: { ...snapshot, sourceConfigBeforeMigrations: undefined },
        configWriteOptions: writeOptions,
        jsonMode: true,
      });
      expect(result).toMatchObject({
        repaired: false,
        warnings: [expect.stringContaining("unresolved: original roster unavailable")],
      });
      expect(result).toMatchObject({
        warnings: [
          expect.stringContaining(
            '{"agentId":"<agentId>","match":{"channel":"discord","accountId":"default"}}',
          ),
        ],
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    });
  });

  it.each(["update channel", "manual Doctor"])(
    "preserves the historical account owner and narrower route through %s",
    async (flow) => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const narrowerRoute = {
          agentId: "research",
          match: { channel: "discord", peer: { kind: "direct", id: "research-user" } },
        };
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: { mode: "local", bind: "localhost" },
            agents: { list: [{ id: "ops" }, { id: "research" }] },
            channels: { discord: { accounts: { default: {} } } },
            bindings: [narrowerRoute],
          }),
        );
        resetConfigRuntimeState();
        const { snapshot, writeOptions } = await createConfigIO({
          pluginValidation: "skip",
        }).readConfigFileSnapshotForWrite();
        expect(snapshot.sourceConfigBeforeMigrations?.agents?.list).toEqual([
          { id: "ops" },
          { id: "research" },
        ]);
        if (flow === "update channel") {
          const plan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
          expect(plan).toBeDefined();
          await repairLegacyConfigForUpdateChannel({
            configSnapshot: snapshot,
            plan,
            configWriteOptions: writeOptions,
            jsonMode: true,
          });
        } else {
          const result = applyLegacyCompatibilityStep({
            snapshot,
            state: {
              cfg: snapshot.sourceConfig,
              candidate: snapshot.sourceConfig,
              pendingChanges: false,
              fixHints: [],
            },
            shouldRepair: true,
            doctorFixCommand: "openclaw doctor --fix",
          });
          expect(result.state.pendingChanges).toBe(true);
          await replaceConfigFile({
            sourceConfig: result.state.candidate,
            baseHash: snapshot.hash,
            writeOptions: { ...writeOptions, auditOrigin: "doctor", skipOutputLogs: true },
          });
        }
        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(persisted.bindings).toEqual([
          narrowerRoute,
          { agentId: "ops", match: { channel: "discord", accountId: "default" } },
        ]);
      });
    },
  );

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
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-before");
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: {
              mode: "local",
              ...(flow === "legacy" ? { bind: "localhost" } : {}),
              auth: { mode: "token", token: "${UPDATE_PROVENANCE_TOKEN}" },
            },
          }),
        );
        vi.stubEnv(POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV, requestedChannel);
        resetConfigRuntimeState();
        const prepared = await createConfigIO({
          pluginValidation: "skip",
        }).readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.sourceConfig.gateway?.auth?.token).toBe("synthetic-before");
        if (flow === "plugins") {
          expect(prepared.snapshot.valid).toBe(true);
          await updatePluginsAfterCoreUpdate({
            root: home,
            channel: "stable",
            configSnapshot: prepared.snapshot,
            configWriteOptions: prepared.writeOptions,
            timeoutMs: 1000,
            json: true,
            pluginInstallRecords: {},
          });
        } else if (flow === "legacy") {
          vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
          const result = await repairLegacyConfigForUpdateChannel({
            configSnapshot: prepared.snapshot,
            configWriteOptions: prepared.writeOptions,
            jsonMode: true,
          });
          expect(result.repaired).toBe(true);
        } else if (flow === "converge") {
          await convergeUpdatePlugins({
            candidateRuntime: true,
            result: {
              status: "ok",
              mode: "git",
              root: home,
              before: { sha: "same", version: "2026.9.2" },
              after: { sha: "same", version: "2026.9.2" },
              steps: [],
              durationMs: 0,
            },
            root: home,
            installKindChanged: false,
            configSnapshot: prepared.snapshot,
            requestedChannel: requestedChannel ?? null,
            storedChannel: null,
            channel: "stable",
            downgradeRisk: false,
            opts: { json: true },
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            updateStepTimeoutMs: 1000,
          });
        } else if (flow === "resume") {
          // The real exit is a process boundary, not part of config persistence.
          vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
          vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          await resumePostCoreUpdate({
            root: home,
            channel: "stable",
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
        expect(saved.gateway?.auth?.token).toBe("${UPDATE_PROVENANCE_TOKEN}");
        if (flow !== "legacy") {
          expect(saved.gateway?.port).toBe(19001);
        } else {
          expect(saved.gateway?.bind).toBe("loopback");
        }
        if (requestedChannel) {
          expect(saved.update?.channel).toBe(requestedChannel);
        } else {
          expect(saved.update?.channel).toBeUndefined();
        }
        const after = await readConfigFileSnapshot();
        expect(after.sourceConfig.gateway?.auth?.token).toBe("synthetic-after");
      });
    },
  );
});
