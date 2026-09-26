import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import {
  commandCalls,
  doctorCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  getLogOutput,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  mockMutableConfigSnapshot,
  npmPluginUpdateCall,
  packageInstallCommandCall,
  replaceConfigCall,
  spawnCall,
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
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveNpmChannelTag,
  runCommandWithTimeout,
  runDaemonRestart,
  updateCliShared,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  npmPluginUpdateResult,
  pluginSyncResult,
  stableConfig,
  stableWhatsAppConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

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

  it.each([
    { channel: "stable", tag: "main" },
    { channel: "extended-stable", tag: "latest" },
  ])("does not migrate authored config for a refused target $channel/$tag", async (target) => {
    await mockPackageInstallAtCaseDir();
    const stateDir = tempDirs.make("openclaw-refused-legacy-target-");
    const configPath = path.join(stateDir, "openclaw.json");
    await writeJsonFixture(configPath, { channels: { slack: { streaming: "partial" } } });
    const before = await fs.readFile(configPath, "utf8");
    const { createConfigIO } = await import("../config/io.js");
    vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
      createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
    );
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementationOnce(
      async ({ configSnapshot: authored }) => {
        await replaceConfigFile({ nextConfig: {}, baseHash: authored.hash });
        return { snapshot: configSnapshot({}, { valid: true }), repaired: true };
      },
    );
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await expect(updateCommand({ ...target, yes: true })).rejects.toEqual(new ExitError(1));
      },
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).not.toHaveBeenCalled();
    expectNoSideEffects(launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob);
  });

  it.each([undefined, "beta"] as const)(
    "persists a source-bound legacy plan only after same-version target admission (stored=%s)",
    async (initialChannel) => {
      await mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
      const stateDir = tempDirs.make("openclaw-legacy-channel-");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      const configPath = path.join(stateDir, "openclaw.json");
      const authored = {
        gateway: { mode: "local", bind: "localhost" },
        ...(initialChannel ? { update: { channel: initialChannel } } : {}),
      };
      await writeJsonFixture(configPath, authored);
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
              expect(params.plan?.snapshot.hash).toBe(before.hash);
              expect(params.plan?.snapshot.path).toBe(configPath);
              return repairLegacyConfigForUpdateChannel(params);
            },
          );
          await updateCommand({ channel: "beta", yes: true, restart: false, json: true });
          const after = await io.readConfigFileSnapshot();
          expect(after.valid).toBe(true);
          expect(after.config.gateway?.bind).toBe("loopback");
          expect(after.config.update?.channel).toBe("beta");
          expect(replaceConfigFile).toHaveBeenCalledTimes(initialChannel ? 1 : 2);
          expect(replaceConfigCall()?.baseHash).toBe(before.hash);
          expect(replaceConfigCall()?.writeOptions?.expectedConfigPath).toBe(configPath);
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
    },
  );

  it.each(["stable", "beta"] as const)(
    "keeps the caller legacy plan out of a same-version service-profile switch from %s",
    async (serviceChannel) => {
      const root = await mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
      const callerState = profileStateDir("personal");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: callerState });
      const serviceState = profileStateDir("work");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: serviceState });
      tempDirsToCleanup.add(callerState);
      tempDirsToCleanup.add(serviceState);
      await fs.mkdir(callerState, { recursive: true });
      await fs.mkdir(serviceState, { recursive: true });
      const callerPath = path.join(callerState, "openclaw.json");
      const servicePath = path.join(serviceState, "openclaw.json");
      await writeJsonFixture(callerPath, { gateway: { mode: "local", bind: "localhost" } });
      await writeJsonFixture(servicePath, {
        gateway: { mode: "local", bind: "lan" },
        update: { channel: serviceChannel },
      });
      const callerBefore = await fs.readFile(callerPath, "utf8");
      readPackageVersion.mockResolvedValue(VERSION);
      primeNpmChannelTag("beta", VERSION);
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: serviceState,
        OPENCLAW_CONFIG_PATH: servicePath,
      });
      const { createConfigIO } = await import("../config/io.js");
      const { replaceConfigFile: writeActualConfig } = await import("../config/mutate.js");
      vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
        createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
      );
      vi.mocked(replaceConfigFile).mockImplementation(writeActualConfig);
      await withEnvAsync(
        {
          OPENCLAW_PROFILE: "personal",
          OPENCLAW_STATE_DIR: callerState,
          OPENCLAW_CONFIG_PATH: callerPath,
        },
        () => updateCommand({ channel: "beta", yes: true, json: true }),
      );
      expect(await fs.readFile(callerPath, "utf8")).toBe(callerBefore);
      const serviceAfter = await createConfigIO({
        env: { ...process.env, OPENCLAW_CONFIG_PATH: servicePath },
        observe: false,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      expect(serviceAfter.config.gateway?.bind).toBe("lan");
      expect(serviceAfter.config.update?.channel).toBe("beta");
      expect(legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).not.toHaveBeenCalled();
      expectNoSideEffects(serviceStop, serviceRestart, candidateValidation);
      expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ coreVersion: VERSION, updateChannel: "beta" }),
      );
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(lastWriteJsonCall()).toMatchObject({
        status: serviceChannel === "beta" ? "skipped" : "ok",
      });
      expect(replaceConfigFile).toHaveBeenCalledTimes(serviceChannel === "beta" ? 0 : 1);
    },
  );

  it("validates a legacy projection without changing authored config on candidate refusal", async () => {
    await mockPackageInstallAtCaseDir();
    const stateDir = tempDirs.make("openclaw-legacy-candidate-");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const configPath = path.join(stateDir, "openclaw.json");
    await writeJsonFixture(configPath, { gateway: { mode: "local", bind: "localhost" } });
    const before = await fs.readFile(configPath, "utf8");
    const { createConfigIO } = await import("../config/io.js");
    vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
      createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
    );
    candidateValidation.mockImplementationOnce(async (options) => {
      expect(options.config.gateway.bind).toBe("loopback");
      expect(await fs.readFile(configPath, "utf8")).toBe(before);
      throw new Error("candidate refused the projected config");
    });
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await expect(
          updateCommand({ channel: "beta", yes: true, restart: false, json: true }),
        ).rejects.toEqual(new ExitError(1));
      },
    );
    expect(candidateValidation).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    expectNoSideEffects(
      replaceConfigFile,
      serviceStop,
      serviceRestart,
      legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
    );
    expect(doctorCommandCall()).toBeUndefined();
  });

  it("preserves service runtime materialization when the caller has a foreign legacy plan", async () => {
    const root = await mockPackageInstallAtCaseDir();
    const callerState = profileStateDir("personal");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: callerState });
    const serviceState = profileStateDir("work");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: serviceState });
    tempDirsToCleanup.add(callerState);
    tempDirsToCleanup.add(serviceState);
    await fs.mkdir(callerState, { recursive: true });
    await fs.mkdir(serviceState, { recursive: true });
    const callerPath = path.join(callerState, "openclaw.json");
    const servicePath = path.join(serviceState, "openclaw.json");
    await writeJsonFixture(callerPath, { gateway: { mode: "local", bind: "localhost" } });
    await writeJsonFixture(servicePath, { gateway: { mode: "local", bind: "lan" } });
    const before = await fs.readFile(callerPath, "utf8");
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: serviceState,
      OPENCLAW_CONFIG_PATH: servicePath,
    });
    const { createConfigIO } = await import("../config/io.js");
    vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
      createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
    );
    const selected = await createConfigIO({
      env: {
        ...process.env,
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: serviceState,
        OPENCLAW_CONFIG_PATH: servicePath,
      },
      observe: false,
      pluginValidation: "skip",
    }).readConfigFileSnapshot();
    expect(selected.config).not.toEqual(selected.sourceConfig);
    candidateValidation.mockRejectedValueOnce(new Error("candidate refused materialized config"));
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: callerState,
        OPENCLAW_CONFIG_PATH: callerPath,
      },
      async () => {
        await expect(
          updateCommand({ channel: "beta", yes: true, restart: false, json: true }),
        ).rejects.toEqual(new ExitError(1));
      },
    );
    expect(candidateValidation).toHaveBeenCalledTimes(1);
    expect(candidateValidation.mock.calls[0]?.[0].config).toEqual(selected.config);
    expect(await fs.readFile(callerPath, "utf8")).toBe(before);
    expectNoSideEffects(
      replaceConfigFile,
      serviceStop,
      serviceRestart,
      legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
    );
    expect(doctorCommandCall()).toBeUndefined();
  });

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

  it("does not repair legacy config during a dry run", async () => {
    await mockPackageInstallAtCaseDir();
    const legacyConfig = {
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(legacyConfig, {
        valid: false,
        hash: "legacy-hash",
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

    await updateCommand({ dryRun: true, channel: "beta", yes: true });

    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(commandCalls().map(([argv]) => argv)).toEqual(runtimeRecovery.expectedNpmProbes);
    expect(legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).not.toHaveBeenCalled();
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

  it("keeps the requested channel when plugin sync writes config after update", async () => {
    await mockPackageInstallAtCaseDir();
    mockMutableConfigSnapshot(baseSnapshot);
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(config, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ channel: "beta", yes: true });

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
  });

  it("refreshes post-doctor config before post-update plugin sync", async () => {
    await mockPackageInstallAtCaseDir();
    const preUpdateConfig = { update: { channel: "stable" } } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      meta: { lastTouchedVersion: "2026.5.14" },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce({
        ...baseSnapshot,
        sourceConfig: preUpdateConfig,
        config: preUpdateConfig,
        hash: "pre-update-hash",
      })
      .mockResolvedValue({
        ...baseSnapshot,
        sourceConfig: postDoctorConfig,
        config: postDoctorConfig,
        hash: "post-doctor-hash",
      });
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(
        {
          ...config,
          plugins: {
            ...config.plugins,
            load: { paths: ["/tmp/openclaw-updated-plugin"] },
          },
        },
        true,
      ),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ yes: true });

    const syncConfig = syncPluginCall()?.config;
    const lastWrite = lastReplaceConfigCall();
    expect(syncConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
    expect(lastWrite?.baseHash).toBe("post-doctor-hash");
    expect(lastWrite?.nextConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
  });

  it("restores pre-update channels when post-core resume sees post-doctor config without them", async () => {
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig({ meta: { lastTouchedVersion: "2026.5.14" } });
    await setupPostCoreConfigFixture({
      preUpdateConfig,
      backupConfig: postDoctorConfig,
      postDoctorConfig,
    });

    await runPostCoreUpdate();

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { meta?: { lastTouchedVersion?: string } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          baseHash?: string;
          nextConfig?: OpenClawConfig & {
            meta?: { lastTouchedVersion?: string };
            channels?: { whatsapp?: { enabled?: boolean; dmPolicy?: string } };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp).toEqual(preUpdateConfig.channels?.whatsapp);
    expect(syncConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
    expect(lastWrite?.baseHash).toBe("post-doctor-hash");
    expect(lastWrite?.nextConfig?.channels?.whatsapp).toEqual(preUpdateConfig.channels?.whatsapp);
    expect(lastWrite?.nextConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
  });

  it("restores pre-update channel model overrides when post-core resume restores a channel", async () => {
    const preUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
        telegram: {
          enabled: true,
        },
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
        telegram: {
          enabled: true,
        },
        modelByChannel: {
          openai: {
            telegram: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;
    await setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });

    await runPostCoreUpdate();

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & {
          channels?: {
            modelByChannel?: Record<string, Record<string, string>>;
          };
        })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: {
              modelByChannel?: Record<string, Record<string, string>>;
            };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.modelByChannel?.openai?.whatsapp).toBe("openai/gpt-5.5");
    expect(syncConfig?.channels?.modelByChannel?.openai?.telegram).toBe("openai/gpt-5.4");
    expect(lastWrite?.nextConfig?.channels?.modelByChannel?.openai?.whatsapp).toBe(
      "openai/gpt-5.5",
    );
    expect(lastWrite?.nextConfig?.channels?.modelByChannel?.openai?.telegram).toBe(
      "openai/gpt-5.4",
    );
  });

  it("persists authored channel values when post-core restore input is resolved", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const resolvedPreUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          token: "resolved-secret",
        },
      },
    } as OpenClawConfig;
    const authoredPreUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          token: "${WHATSAPP_TOKEN}",
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      meta: { lastTouchedVersion: "2026.5.14" },
    } as OpenClawConfig;
    await fs.mkdir(tempDir, { recursive: true });
    await writeJsonFixture(sourceConfigPath, {
      sourceConfig: resolvedPreUpdateConfig,
      authoredConfig: authoredPreUpdateConfig,
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      sourceConfig: postDoctorConfig,
      config: postDoctorConfig,
      runtimeConfig: postDoctorConfig,
      hash: "post-doctor-hash",
    });
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate({ OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath });

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { channels?: { whatsapp?: { token?: string } } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: { whatsapp?: { token?: string } };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp?.token).toBe("resolved-secret");
    expect(lastWrite?.nextConfig?.channels?.whatsapp?.token).toBe("${WHATSAPP_TOKEN}");
  });

  it("resolves included pre-update channels for old post-core parents", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    const channelsPath = path.join(tempDir, "channels.json5");
    const includedChannels = {
      whatsapp: {
        enabled: true,
        token: "${WHATSAPP_TOKEN}",
      },
    };
    const preUpdateConfig = {
      update: { channel: "stable" },
      channels: { $include: "./channels.json5" },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      channels: {},
    } as OpenClawConfig;
    await fs.mkdir(tempDir, { recursive: true });
    await writeJsonFixture(channelsPath, includedChannels);
    await writeJsonFixture(`${configPath}.bak`, preUpdateConfig);
    await writeJsonFixture(configPath, postDoctorConfig);
    mockPostDoctorSnapshot(configPath, postDoctorConfig);
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate({ WHATSAPP_TOKEN: "resolved-token" });

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { channels?: { whatsapp?: { token?: string } } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: { $include?: string };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp?.token).toBe("resolved-token");
    expect(lastWrite?.nextConfig?.channels).toEqual({ $include: "./channels.json5" });
  });

  it("uses source config and plugin index records for post-update plugin sync", async () => {
    await mockPackageInstallAtCaseDir();
    const pluginInstallRecords = {
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/lossless-claw",
      },
    } as const;
    const sourceConfig = {
      plugins: {},
    } as OpenClawConfig;
    loadInstalledPluginIndexInstallRecords.mockResolvedValue(pluginInstallRecords);
    mockMutableConfigSnapshot({
      ...baseSnapshot,
      sourceConfig,
      config: {
        ...sourceConfig,
        gateway: { auth: { mode: "token", token: "runtime" } },
        plugins: {
          ...sourceConfig.plugins,
          entries: {
            firecrawl: {
              config: {
                webFetch: { provider: "firecrawl" },
              },
            },
          },
        },
      } as OpenClawConfig,
    });
    syncPluginsForUpdateChannel.mockResolvedValue(pluginSyncResult(sourceConfig));
    updateNpmInstalledPlugins.mockResolvedValue(npmPluginUpdateResult(sourceConfig));

    await updateCommand({ channel: "beta", yes: true });

    const syncConfig = syncPluginCall()?.config;
    const updateCall = npmPluginUpdateCall() as
      | { skipDisabledPlugins?: boolean; syncOfficialPluginInstalls?: boolean }
      | undefined;
    expect(syncConfig?.plugins?.installs).toEqual(pluginInstallRecords);
    expect(syncConfig?.update?.channel).toBe("beta");
    expect(syncConfig?.gateway?.auth).toBeUndefined();
    expect(syncConfig?.plugins?.entries).toBeUndefined();
    expect(updateCall?.skipDisabledPlugins).toBe(true);
    expect(updateCall?.syncOfficialPluginInstalls).toBe(true);
  });

  it.each(["ok", "error"] as const)(
    "hands the checkout to global activation and fresh finalization only after Git update success (%s)",
    async (status) => {
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
      vi.mocked(readConfigFileSnapshot).mockResolvedValue({
        ...baseSnapshot,
        parsed: { update: { channel: "stable" } },
        resolved: { update: { channel: "stable" } } as OpenClawConfig,
        sourceConfig: { update: { channel: "stable" } } as OpenClawConfig,
        runtimeConfig: { update: { channel: "stable" } } as OpenClawConfig,
        config: { update: { channel: "stable" } } as OpenClawConfig,
      });
      const updateResult = makeOkUpdateResult({
        status,
        mode: "git",
        root: gitRoot,
        after: { sha, version: "2026.8.1" },
      });
      if (status === "ok") {
        mockGitUpdateAfterMutation(updateResult);
      } else {
        vi.mocked(updateGitCheckout).mockResolvedValue(updateResult);
      }
      mockNoopPostUpdatePluginConvergence();

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        const command = updateCommand({ channel: "dev", yes: true, restart: false });
        if (status === "error") {
          await expect(command).rejects.toEqual(new ExitError(1));
        } else {
          await command;
        }
      });
      if (status === "error") {
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expectNoSideEffects(spawn, replaceConfigFile, completionCacheSpy);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2026.4.10"');
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        return;
      }
      await expect(fs.realpath(packageRoot)).resolves.toBe(await fs.realpath(gitRoot));
      // A real built entry resumes finalization in fresh code, not this old process.
      expect(spawnCall()?.[1]?.[0]).toBe(path.join(gitRoot, "dist", "entry.js"));
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
      expectNoSideEffects(
        replaceConfigFile,
        syncPluginsForUpdateChannel,
        updateNpmInstalledPlugins,
      );
      expect(completionCacheSpy).toHaveBeenCalledWith(gitRoot, false);
      expectNoSideEffects(runDaemonRestart);
      expect(freshRestartCalls()).toHaveLength(0);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    },
  );
});
