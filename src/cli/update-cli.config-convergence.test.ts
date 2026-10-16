import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as configIo from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import {
  doctorCommandCall,
  expectNoSideEffects,
  getLogOutput,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  mockMutableConfigSnapshot,
  npmPluginUpdateCall,
  packageInstallCommandCall,
  replaceConfigCall,
  syncPluginCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  candidateValidation,
  launchdUpdateCleanupMocks,
  legacyConfigRepairMocks,
  loadInstalledPluginIndexInstallRecords,
  readPackageVersion,
  serviceRestart,
  serviceStop,
  spawn,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  makeOkUpdateResult,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveNpmChannelTag,
  runCommandWithTimeout,
  updateCliShared,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  npmPluginUpdateResult,
  pluginSyncResult,
  stableWhatsAppConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

async function useFileBackedConfigIO() {
  const { createConfigIO } =
    await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  vi.spyOn(configIo, "createConfigIO").mockImplementation(createConfigIO);
  return createConfigIO;
}

describe("update-cli", () => {
  const {
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    initializeExistingUpdateProfile,
    mockFileBackedPathExists,
    mockNoopPostUpdatePluginConvergence,
    mockNpmGlobalCommands,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockPostDoctorSnapshot,
    mockRunningManagedGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    runPostCoreUpdate,
    setupPostCoreConfigFixture,
    tempDirs,
    tempDirsToCleanup,
  } = createUpdateCliFixture();

  const legacyConfig = { gateway: { mode: "local", bind: "localhost" } };
  const serviceArgs = (root: string) => [
    "node",
    path.join(root, "dist", "index.js"),
    "gateway",
    "run",
  ];
  const profileEnv = (profile: string, state: string) => ({
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  });
  async function writeProfile(state: string, config: unknown) {
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: state });
    tempDirsToCleanup.add(state);
    await fs.mkdir(state, { recursive: true });
    const configPath = path.join(state, "openclaw.json");
    await writeJsonFixture(configPath, config);
    return configPath;
  }
  function readFrom(createConfigIO: typeof configIo.createConfigIO) {
    vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
      createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
    );
  }

  it("does not migrate authored config for a refused target stable/main", async () => {
    await mockPackageInstallAtCaseDir();
    const stateDir = tempDirs.make("openclaw-refused-legacy-target-");
    const configPath = path.join(stateDir, "openclaw.json");
    await writeJsonFixture(configPath, { channels: { slack: { streaming: "partial" } } });
    const before = await fs.readFile(configPath, "utf8");
    const { createConfigIO } = await import("../config/io.js");
    readFrom(createConfigIO);
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementationOnce(
      async ({ configSnapshot: authored }) => {
        await replaceConfigFile({ nextConfig: {}, baseHash: authored.hash });
        return { snapshot: configSnapshot({}, { valid: true }), repaired: true };
      },
    );
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await expect(updateCommand({ channel: "stable", tag: "main", yes: true })).rejects.toEqual(
          new ExitError(1),
        );
      },
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).not.toHaveBeenCalled();
    expectNoSideEffects(launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob);
  });

  it("persists a source-bound legacy plan only after same-version target admission", async () => {
    await mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
    const stateDir = tempDirs.make("openclaw-legacy-channel-");
    const configPath = await writeProfile(stateDir, legacyConfig);
    readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("beta", VERSION);
    const { createConfigIO } = await import("../config/io.js");
    const { repairLegacyConfigForUpdateChannel } = await vi.importActual<
      typeof import("../commands/doctor/legacy-config-repair.js")
    >("../commands/doctor/legacy-config-repair.js");
    const { replaceConfigFile: writeActualConfig } = await import("../config/mutate.js");
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const io = createConfigIO({ observe: false, pluginValidation: "skip" });
        const before = await io.readConfigFileSnapshot();
        expect(before.valid).toBe(false);
        vi.mocked(readConfigFileSnapshot).mockImplementation(() => io.readConfigFileSnapshot());
        vi.mocked(replaceConfigFile).mockImplementation(writeActualConfig);
        legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
          async (params) => {
            expect(resolveNpmChannelTag).toHaveBeenCalled();
            expect(await fs.readFile(configPath, "utf8")).toBe(before.raw);
            expect(params.plan?.snapshot).toMatchObject({ hash: before.hash, path: configPath });
            return repairLegacyConfigForUpdateChannel(params);
          },
        );
        await updateCommand({ channel: "beta", yes: true, restart: false, json: true });
        const after = await io.readConfigFileSnapshot();
        expect(after).toMatchObject({
          valid: true,
          config: { gateway: { bind: "loopback" }, update: { channel: "beta" } },
        });
        expect(replaceConfigFile).toHaveBeenCalledTimes(2);
        expect(replaceConfigCall()).toMatchObject({
          baseHash: before.hash,
          writeOptions: { expectedConfigPath: configPath },
        });
      },
    );
    expect(legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).toHaveBeenCalledTimes(1);
    expectNoSideEffects(serviceStop, serviceRestart, candidateValidation);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ coreVersion: VERSION, updateChannel: "beta" }),
    );
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(doctorCommandCall()).toBeUndefined();
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
  });

  it("refuses a foreign legacy caller without an explicit channel request", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
    const callerState = profileStateDir("personal");
    const serviceState = profileStateDir("work");
    const callerPath = await writeProfile(callerState, legacyConfig);
    const servicePath = await writeProfile(serviceState, {
      gateway: { mode: "local", bind: "lan" },
      update: { channel: "stable" },
    });
    const callerBefore = await fs.readFile(callerPath, "utf8");
    const serviceBefore = await fs.readFile(servicePath, "utf8");
    readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("latest", VERSION);
    mockRunningManagedGateway(serviceArgs(root));
    primeServiceCommand(serviceArgs(root), {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      ...profileEnv("work", serviceState),
    });
    const createConfigIO = await useFileBackedConfigIO();
    const { replaceConfigFile: writeActualConfig } = await import("../config/mutate.js");
    readFrom(createConfigIO);
    vi.mocked(replaceConfigFile).mockImplementation(writeActualConfig);
    await withEnvAsync(profileEnv("personal", callerState), async () => {
      await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
    });
    expect(await fs.readFile(callerPath, "utf8")).toBe(callerBefore);

    expect(await fs.readFile(servicePath, "utf8")).toBe(serviceBefore);
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "invalid-config" });
    expectNoSideEffects(
      serviceStop,
      serviceRestart,
      candidateValidation,
      replaceConfigFile,
      updateNpmInstalledPlugins,
      legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
    );
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each(["caller", "service"] as const)(
    "preserves authored legacy config when the %s candidate is refused",
    async (owner) => {
      const root = await mockPackageInstallAtCaseDir();
      const stateDir =
        owner === "service"
          ? profileStateDir("personal")
          : tempDirs.make("openclaw-legacy-candidate-");
      const configPath = await writeProfile(stateDir, legacyConfig);
      const before = await fs.readFile(configPath, "utf8");
      const createConfigIO =
        owner === "service"
          ? await useFileBackedConfigIO()
          : (await import("../config/io.js")).createConfigIO;
      readFrom(createConfigIO);
      let selectedConfig: OpenClawConfig | undefined;
      if (owner === "service") {
        const serviceState = profileStateDir("work");
        await writeProfile(serviceState, { gateway: { mode: "local", bind: "lan" } });
        mockRunningManagedGateway(serviceArgs(root));
        const serviceEnv = {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          ...profileEnv("work", serviceState),
        };
        primeServiceCommand(serviceArgs(root), serviceEnv);
        const selected = await createConfigIO({
          env: {
            ...process.env,
            ...profileEnv("work", serviceState),
          },
          observe: false,
          pluginValidation: "skip",
        }).readConfigFileSnapshot();
        expect(selected.config).not.toEqual(selected.sourceConfig);
        selectedConfig = selected.config;
      }
      candidateValidation.mockImplementationOnce(async (options) => {
        if (owner === "caller") {
          expect(options.config.gateway.bind).toBe("loopback");
          expect(await fs.readFile(configPath, "utf8")).toBe(before);
        }
        throw new Error(
          owner === "caller"
            ? "candidate refused the projected config"
            : "candidate refused materialized config",
        );
      });
      await withEnvAsync(
        {
          ...(owner === "service" ? { OPENCLAW_PROFILE: "personal" } : {}),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        async () => {
          await expect(
            updateCommand({ channel: "beta", yes: true, restart: false, json: true }),
          ).rejects.toEqual(new ExitError(1));
        },
      );
      expect(candidateValidation).toHaveBeenCalledTimes(1);
      if (owner === "service") {
        expect(candidateValidation.mock.calls[0]?.[0].config).toEqual(selectedConfig);
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      expectNoSideEffects(
        replaceConfigFile,
        serviceStop,
        serviceRestart,
        legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
      );
      expect(doctorCommandCall()).toBeUndefined();
    },
  );

  it("does not auto-repair legacy config when authored includes are present", async () => {
    await mockPackageInstallAtCaseDir();
    const legacyConfigWithInclude = {
      $include: "./channels.json5",
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as unknown as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(legacyConfigWithInclude, {
        valid: false,
        hash: "legacy-include-hash",
        issues: [
          {
            path: "channels.slack.streaming",
            message: "Invalid input: expected object, received string",
          },
        ],
        legacyIssues: [
          {
            path: "channels.slack",
            message: "legacy slack streaming keys",
          },
        ],
      }),
    );

    await expect(updateCommand({ channel: "beta", yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(replaceConfigFile, runCommandWithTimeout);
    expect(getLogOutput()).toContain("Update mode: package");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("does not persist the requested channel when the package update fails", async () => {
    await mockPackageInstallAtCaseDir();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return commandResult({ stderr: "install failed", code: 1 });
      }
      return commandResult();
    });

    await expect(updateCommand({ channel: "beta", yes: true })).rejects.toEqual(new ExitError(1));

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("restores pre-update channel model overrides when post-core resume restores a channel", async () => {
    const updateStartedAtMs = Date.now();
    const channelConfig = stableWhatsAppConfig();
    const preUpdateConfig = {
      ...channelConfig,
      channels: {
        ...channelConfig.channels,
        telegram: { enabled: true },
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.5",
            telegram: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      channels: {
        telegram: { enabled: true },
        modelByChannel: {
          openai: {
            telegram: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;
    await setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });

    await runPostCoreUpdate({ OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) });

    const restored = {
      channels: {
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.5",
            telegram: "openai/gpt-5.4",
          },
        },
      },
    };
    expect(syncPluginCall()?.config).toMatchObject(restored);
    expect(lastReplaceConfigCall()?.nextConfig).toMatchObject(restored);
  });

  it.each(["payload", "included-backup"] as const)(
    "restores authored channel values from %s",
    async (source) => {
      const tempDir = createCaseDir("openclaw-update");
      const sourceConfigPath = path.join(tempDir, "source-config.json");
      const configPath = path.join(tempDir, "openclaw.json");
      const updateStartedAtMs = Date.now();
      const authoredChannels = { whatsapp: { enabled: true, token: "${WHATSAPP_TOKEN}" } };
      await fs.mkdir(tempDir, { recursive: true });
      if (source === "payload") {
        await writeJsonFixture(sourceConfigPath, {
          sourceConfig: {
            update: { channel: "stable" },
            channels: { whatsapp: { enabled: true, token: "resolved-secret" } },
          },
          authoredConfig: { update: { channel: "stable" }, channels: authoredChannels },
        });
        const postDoctorConfig = {
          update: { channel: "stable" },
          meta: { lastTouchedVersion: "2026.5.14" },
        } satisfies OpenClawConfig;
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          sourceConfig: postDoctorConfig,
          config: postDoctorConfig,
          runtimeConfig: postDoctorConfig,
          hash: "post-doctor-hash",
        });
      } else {
        const postDoctorConfig = {
          update: { channel: "stable" },
          channels: {},
        } satisfies OpenClawConfig;
        await writeJsonFixture(path.join(tempDir, "channels.json5"), authoredChannels);
        await writeJsonFixture(`${configPath}.bak`, {
          update: { channel: "stable" },
          channels: { $include: "./channels.json5" },
        });
        await writeJsonFixture(configPath, postDoctorConfig);
        mockPostDoctorSnapshot(configPath, postDoctorConfig);
      }
      mockNoopPostUpdatePluginConvergence();

      await runPostCoreUpdate(
        source === "payload"
          ? {
              OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
              OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: undefined,
            }
          : {
              WHATSAPP_TOKEN: "resolved-token",
              OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs),
            },
      );

      expect(syncPluginCall()?.config).toMatchObject({
        channels: {
          whatsapp: { token: source === "payload" ? "resolved-secret" : "resolved-token" },
        },
      });
      if (source === "payload") {
        expect(lastReplaceConfigCall()?.nextConfig).toMatchObject({
          channels: { whatsapp: { token: "${WHATSAPP_TOKEN}" } },
        });
      } else {
        expect(lastReplaceConfigCall()?.nextConfig?.channels).toEqual({
          $include: "./channels.json5",
        });
      }
    },
  );

  it("uses source config and plugin index records for post-update plugin sync", async () => {
    await mockPackageInstallAtCaseDir();
    const pluginInstallRecords = {
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/lossless-claw",
      },
    } as const;
    const sourceConfig: OpenClawConfig = { plugins: {} };
    loadInstalledPluginIndexInstallRecords.mockResolvedValue(pluginInstallRecords);
    mockMutableConfigSnapshot({
      ...baseSnapshot,
      sourceConfig,
      config: {
        ...sourceConfig,
        gateway: { auth: { mode: "token", token: "runtime" } },
        plugins: {
          ...sourceConfig.plugins,
          entries: { firecrawl: { config: { webFetch: { provider: "firecrawl" } } } },
        },
      } as OpenClawConfig,
    });
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(config, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ channel: "beta", yes: true });

    const syncConfig = syncPluginCall()?.config;
    expect(syncConfig?.plugins?.installs).toEqual(pluginInstallRecords);
    expect(syncConfig?.update?.channel).toBe("beta");
    expect(syncConfig?.gateway?.auth).toBeUndefined();
    expect(syncConfig?.plugins?.entries).toBeUndefined();
    expect(npmPluginUpdateCall()).toMatchObject({
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
    });
    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
  });

  it("does not activate or finalize a failed Git update", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const gitRoot = path.join(tempDir, "..", "openclaw");
    const completionCacheSpy = vi
      .spyOn(updateCliShared, "tryWriteCompletionCache")
      .mockResolvedValueOnce("completed");
    const nodeModules = path.join(tempDir, "prefix", "lib", "node_modules");
    const packageRoot = path.join(nodeModules, "openclaw");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
    await writeOpenClawPackageFixture(gitRoot, "2026.8.1", { git: true, builtSha: sha });
    mockPackageInstallStatus(packageRoot);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "stable" } }),
    );
    const updateResult = makeOkUpdateResult({
      status: "error",
      mode: "git",
      root: gitRoot,
      after: { sha, version: "2026.8.1" },
    });

    vi.mocked(updateGitCheckout).mockResolvedValue(updateResult);

    mockNoopPostUpdatePluginConvergence();

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      const command = updateCommand({ channel: "dev", yes: true, restart: false });

      await expect(command).rejects.toEqual(new ExitError(1));
    });

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(spawn, replaceConfigFile, completionCacheSpy);
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2026.4.10"',
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});
