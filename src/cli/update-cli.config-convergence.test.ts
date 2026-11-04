import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as configIo from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
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

const f = createUpdateCliFixture();

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
function primeManagedProfile(root: string, state: string) {
  f.mockRunningManagedGateway(serviceArgs(root));
  f.primeServiceCommand(serviceArgs(root), {
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
    ...profileEnv("work", state),
  });
}
const expectUpdateFailure = (options: Parameters<typeof cli.updateCommand>[0]) =>
  expect(cli.updateCommand(options)).rejects.toEqual(new cli.ExitError(1));
async function writeProfile(state: string, config: unknown) {
  f.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: state });
  f.tempDirsToCleanup.add(state);
  await fs.mkdir(state, { recursive: true });
  const configPath = path.join(state, "openclaw.json");
  await writeJsonFixture(configPath, config);
  return configPath;
}
function readFrom(createConfigIO: typeof configIo.createConfigIO) {
  vi.mocked(cli.readConfigFileSnapshot).mockImplementation(() =>
    createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
  );
}
const withConfig = <T>(file: string, run: () => Promise<T>, env: NodeJS.ProcessEnv = {}) =>
  withEnvAsync({ ...env, OPENCLAW_STATE_DIR: path.dirname(file), OPENCLAW_CONFIG_PATH: file }, run);

it("does not migrate authored config for a refused target stable/main", async () => {
  await f.mockPackageInstallAtCaseDir();
  const stateDir = f.tempDirs.make("openclaw-refused-legacy-target-");
  const configPath = path.join(stateDir, "openclaw.json");
  await writeJsonFixture(configPath, { channels: { slack: { streaming: "partial" } } });
  const before = await fs.readFile(configPath, "utf8");
  const { createConfigIO } = await import("../config/io.js");
  readFrom(createConfigIO);
  mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementationOnce(
    async ({ configSnapshot: authored }) => {
      await cli.replaceConfigFile({ nextConfig: {}, baseHash: authored.hash });
      return { snapshot: f.configSnapshot({}, { valid: true }), repaired: true };
    },
  );
  await withConfig(configPath, () =>
    expectUpdateFailure({ channel: "stable", tag: "main", yes: true }),
  );
  expect(await fs.readFile(configPath, "utf8")).toBe(before);
  checks.expectNoSideEffects(
    cli.replaceConfigFile,
    mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
    mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
  );
});

it.each([
  { channel: undefined, unknown: false },
  { channel: "beta", unknown: false },
  { channel: undefined, unknown: true },
] as const)(
  "handles same-version legacy config (channel=$channel, unknown=$unknown)",
  async ({ channel, unknown }) => {
    await f.mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
    const stateDir = f.tempDirs.make("openclaw-legacy-channel-");
    const configPath = await writeProfile(stateDir, {
      ...legacyConfig,
      ...(unknown ? { unknownSetting: true } : {}),
    });
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    f.primeNpmChannelTag(channel ?? "latest", VERSION);
    const { createConfigIO } = await import("../config/io.js");
    const { repairLegacyConfigForUpdateChannel } = await vi.importActual<
      typeof import("../commands/doctor/legacy-config-repair.js")
    >("../commands/doctor/legacy-config-repair.js");
    const { replaceConfigFile: writeActualConfig } = await import("../config/mutate.js");
    await withConfig(configPath, async () => {
      const io = createConfigIO({ observe: false, pluginValidation: "skip" });
      const before = await io.readConfigFileSnapshot();
      expect(before.valid).toBe(false);
      vi.mocked(cli.readConfigFileSnapshot).mockImplementation(() => io.readConfigFileSnapshot());
      vi.mocked(cli.replaceConfigFile).mockImplementation(writeActualConfig);
      mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
        async (params) => {
          expect(cli.resolveNpmChannelTag).toHaveBeenCalled();
          expect(await fs.readFile(configPath, "utf8")).toBe(before.raw);
          expect(params.plan?.snapshot).toMatchObject({ hash: before.hash, path: configPath });
          return repairLegacyConfigForUpdateChannel(params);
        },
      );
      const update = cli.updateCommand({ channel, yes: true, restart: false, json: true });
      if (unknown) {
        await expect(update).rejects.toEqual(new cli.ExitError(1));
        expect(checks.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "invalid-config",
        });
        expect(checks.getErrorOutput()).toContain("openclaw doctor --fix");
        expect(await fs.readFile(configPath, "utf8")).toBe(before.raw);
        expect(cli.replaceConfigFile).not.toHaveBeenCalled();
        return;
      }
      await update;
      const after = await io.readConfigFileSnapshot();
      expect(after).toMatchObject({
        valid: true,
        config: { gateway: { bind: "loopback" }, ...(channel ? { update: { channel } } : {}) },
      });
      expect(cli.replaceConfigFile).toHaveBeenCalledTimes(channel ? 2 : 1);
      expect(checks.replaceConfigCall()).toMatchObject({
        baseHash: before.hash,
        writeOptions: { expectedConfigPath: configPath },
      });
      if (!channel) {
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(before.raw);
      }
    });
    if (unknown) {
      expect(
        mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
      ).not.toHaveBeenCalled();
      expect(checks.packageInstallCommandCall()).toBeUndefined();
      return;
    }
    expect(mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel).toHaveBeenCalledTimes(
      1,
    );
    checks.expectNoSideEffects(mocks.serviceStop, mocks.serviceRestart, mocks.candidateValidation);
    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ coreVersion: VERSION, updateChannel: channel ?? "stable" }),
    );
    expect(checks.packageInstallCommandCall()).toBeUndefined();
    expect(checks.doctorCommandCall()).toBeUndefined();
    expect(checks.lastWriteJsonCall()).toMatchObject({ status: "ok" });
  },
);

it("refuses a foreign legacy caller without an explicit channel request", async () => {
  const root = await f.mockPackageInstallAtCaseDir("openclaw-current-legacy-config", VERSION);
  const callerState = f.profileStateDir("personal");
  const serviceState = f.profileStateDir("work");
  const callerPath = await writeProfile(callerState, legacyConfig);
  const servicePath = await writeProfile(serviceState, {
    gateway: { mode: "local", bind: "lan" },
    update: { channel: "stable" },
  });
  const callerBefore = await fs.readFile(callerPath, "utf8");
  const serviceBefore = await fs.readFile(servicePath, "utf8");
  mocks.readPackageVersion.mockResolvedValue(VERSION);
  f.primeNpmChannelTag("latest", VERSION);
  primeManagedProfile(root, serviceState);
  const createConfigIO = await useFileBackedConfigIO();
  const { replaceConfigFile: writeActualConfig } = await import("../config/mutate.js");
  readFrom(createConfigIO);
  vi.mocked(cli.replaceConfigFile).mockImplementation(writeActualConfig);
  await withEnvAsync(profileEnv("personal", callerState), () =>
    expectUpdateFailure({ yes: true, json: true }),
  );
  expect(await fs.readFile(callerPath, "utf8")).toBe(callerBefore);

  expect(await fs.readFile(servicePath, "utf8")).toBe(serviceBefore);
  expect(checks.lastWriteJsonCall()).toMatchObject({ status: "error", reason: "invalid-config" });
  checks.expectNoSideEffects(
    mocks.serviceStop,
    mocks.serviceRestart,
    mocks.candidateValidation,
    cli.replaceConfigFile,
    mocks.updateNpmInstalledPlugins,
    mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
  );
  expect(checks.packageInstallCommandCall()).toBeUndefined();
});

it.each(["caller", "service"] as const)(
  "preserves authored legacy config when the %s candidate is refused",
  async (owner) => {
    const root = await f.mockPackageInstallAtCaseDir();
    const stateDir =
      owner === "service"
        ? f.profileStateDir("personal")
        : f.tempDirs.make("openclaw-legacy-candidate-");
    const configPath = await writeProfile(stateDir, legacyConfig);
    const before = await fs.readFile(configPath, "utf8");
    const createConfigIO =
      owner === "service"
        ? await useFileBackedConfigIO()
        : (await import("../config/io.js")).createConfigIO;
    readFrom(createConfigIO);
    let selectedConfig: OpenClawConfig | undefined;
    if (owner === "service") {
      const serviceState = f.profileStateDir("work");
      await writeProfile(serviceState, { gateway: { mode: "local", bind: "lan" } });
      primeManagedProfile(root, serviceState);
      const selected = await createConfigIO({
        env: { ...process.env, ...profileEnv("work", serviceState) },
        observe: false,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      expect(selected.config).not.toEqual(selected.sourceConfig);
      selectedConfig = selected.config;
    }
    mocks.candidateValidation.mockImplementationOnce(async (options) => {
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
    await withConfig(
      configPath,
      () => expectUpdateFailure({ channel: "beta", yes: true, restart: false, json: true }),
      owner === "service" ? { OPENCLAW_PROFILE: "personal" } : {},
    );
    expect(mocks.candidateValidation).toHaveBeenCalledTimes(1);
    if (owner === "service") {
      expect(mocks.candidateValidation.mock.calls[0]?.[0].config).toEqual(selectedConfig);
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    checks.expectNoSideEffects(
      cli.replaceConfigFile,
      mocks.serviceStop,
      mocks.serviceRestart,
      mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
    );
    expect(checks.doctorCommandCall()).toBeUndefined();
  },
);

it("does not auto-repair legacy config when authored includes are present", async () => {
  await f.mockPackageInstallAtCaseDir();
  const legacyConfigWithInclude = {
    $include: "./channels.json5",
    channels: { slack: { streaming: "partial", nativeStreaming: false } },
  } as unknown as OpenClawConfig;
  vi.mocked(cli.readConfigFileSnapshot).mockResolvedValueOnce(
    f.configSnapshot(legacyConfigWithInclude, {
      valid: false,
      hash: "legacy-include-hash",
      issues: [
        {
          path: "channels.slack.streaming",
          message: "Invalid input: expected object, received string",
        },
      ],
      legacyIssues: [{ path: "channels.slack", message: "legacy slack streaming keys" }],
    }),
  );

  await expectUpdateFailure({ channel: "beta", yes: true });

  checks.expectNoSideEffects(cli.replaceConfigFile, cli.runCommandWithTimeout);
  expect(checks.getLogOutput()).toContain("Update mode: package");
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
});

it("does not persist the requested channel when the package update fails", async () => {
  await f.mockPackageInstallAtCaseDir();
  vi.mocked(cli.runCommandWithTimeout).mockImplementation(async (argv) => {
    if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
      return commandResult({ stderr: "install failed", code: 1 });
    }
    return commandResult();
  });

  await expectUpdateFailure({ channel: "beta", yes: true });

  checks.expectNoSideEffects(cli.replaceConfigFile, cli.defaultRuntime.exit);
});

it("restores pre-update channel model overrides when post-core resume restores a channel", async () => {
  const updateStartedAtMs = Date.now();
  const channelConfig = stableWhatsAppConfig();
  const telegram = { enabled: true };
  const modelByChannel = { openai: { whatsapp: "openai/gpt-5.5", telegram: "openai/gpt-5.4" } };
  const preUpdateConfig = {
    ...channelConfig,
    channels: { ...channelConfig.channels, telegram, modelByChannel },
  } as OpenClawConfig;
  const postDoctorConfig = {
    update: { channel: "stable" },
    channels: { telegram, modelByChannel: { openai: { telegram: "openai/gpt-5.4" } } },
  } as OpenClawConfig;
  await f.setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });

  await f.runPostCoreUpdate({ OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) });

  const restored = { channels: { modelByChannel } };
  expect(checks.syncPluginCall()?.config).toMatchObject(restored);
  expect(checks.lastReplaceConfigCall()?.nextConfig).toMatchObject(restored);
});

it.each(["payload", "included-backup"] as const)(
  "restores authored channel values from %s",
  async (source) => {
    const tempDir = f.createCaseDir("openclaw-update");
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
      vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue({
        ...f.baseSnapshot,
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
      f.mockPostDoctorSnapshot(configPath, postDoctorConfig);
    }
    f.mockNoopPostUpdatePluginConvergence();

    await f.runPostCoreUpdate(
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

    expect(checks.syncPluginCall()?.config).toMatchObject({
      channels: {
        whatsapp: { token: source === "payload" ? "resolved-secret" : "resolved-token" },
      },
    });
    if (source === "payload") {
      expect(checks.lastReplaceConfigCall()?.nextConfig).toMatchObject({
        channels: { whatsapp: { token: "${WHATSAPP_TOKEN}" } },
      });
    } else {
      expect(checks.lastReplaceConfigCall()?.nextConfig?.channels).toEqual({
        $include: "./channels.json5",
      });
    }
  },
);

it("uses source config and plugin index records for post-update plugin sync", async () => {
  await f.mockPackageInstallAtCaseDir();
  const pluginInstallRecords = {
    "lossless-claw": {
      source: "npm",
      spec: "@martian-engineering/lossless-claw",
      installPath: "/tmp/lossless-claw",
    },
  } as const;
  const sourceConfig: OpenClawConfig = { plugins: {} };
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(pluginInstallRecords);
  checks.mockMutableConfigSnapshot({
    ...f.baseSnapshot,
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
  mocks.syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
    pluginSyncResult(config, true),
  );
  mocks.updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
    npmPluginUpdateResult(config),
  );

  await cli.updateCommand({ channel: "beta", yes: true });

  const syncConfig = checks.syncPluginCall()?.config;
  expect(syncConfig?.plugins?.installs).toEqual(pluginInstallRecords);
  expect(syncConfig?.update?.channel).toBe("beta");
  expect(syncConfig?.gateway?.auth).toBeUndefined();
  expect(syncConfig?.plugins?.entries).toBeUndefined();
  expect(checks.npmPluginUpdateCall()).toMatchObject({
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
  });
  expect(checks.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
});

it("does not activate or finalize a failed Git update", async () => {
  const tempDir = f.createCaseDir("openclaw-update");
  const gitRoot = path.join(tempDir, "..", "openclaw");
  const completionCacheSpy = vi
    .spyOn(cli.updateCliShared, "tryWriteCompletionCache")
    .mockResolvedValueOnce("completed");
  const nodeModules = path.join(tempDir, "prefix", "lib", "node_modules");
  const packageRoot = path.join(nodeModules, "openclaw");
  const sha = "a".repeat(40);
  await writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
  await writeOpenClawPackageFixture(gitRoot, "2026.8.1", { git: true, builtSha: sha });
  f.mockPackageInstallStatus(packageRoot);
  f.mockFileBackedPathExists();
  f.mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
  vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(
    f.configSnapshot({ update: { channel: "stable" } }),
  );
  vi.mocked(cli.updateGitCheckout).mockResolvedValue(
    cli.makeOkUpdateResult({
      status: "error",
      mode: "git",
      root: gitRoot,
      after: { sha, version: "2026.8.1" },
    }),
  );

  f.mockNoopPostUpdatePluginConvergence();

  await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, () =>
    expectUpdateFailure({ channel: "dev", yes: true, restart: false }),
  );

  expect(checks.packageInstallCommandCall()?.[0]).toBeUndefined();
  checks.expectNoSideEffects(mocks.spawn, cli.replaceConfigFile, completionCacheSpy);
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"2026.4.10"',
  );
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
});
