import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi, type Mock } from "vitest";
import type { readConfigFileSnapshot as ReadConfigFileSnapshot } from "../../config/config.js";
import { resolveConfigPath } from "../../config/paths.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { writeJsonFixture } from "./update-cli-package.test-support.js";

export const pluginSyncResult = (
  config: OpenClawConfig,
  changed = false,
  overrides: {
    warnings?: string[];
    errors?: Array<{ pluginId: string; message: string; code?: string }>;
  } = {},
) => ({
  changed,
  config,
  summary: {
    switchedToBundled: [],
    switchedToClawHub: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
    ...overrides,
  },
});

export const npmPluginUpdateResult = (config: OpenClawConfig) => ({
  changed: false,
  config,
  outcomes: [],
});

export const postCoreConvergenceResult = (
  overrides: Partial<{
    changes: string[];
    warnings: Array<{ pluginId?: string; reason: string; message: string; guidance: string[] }>;
    errored: boolean;
  }> = {},
) => ({
  changes: [],
  warnings: [],
  errored: false,
  smokeFailures: [],
  installRecords: {},
  ...overrides,
});

export const stableConfig = (overrides: Omit<OpenClawConfig, "update"> = {}): OpenClawConfig => ({
  update: { channel: "stable" },
  ...overrides,
});

export const stableWhatsAppConfig = (): OpenClawConfig =>
  stableConfig({
    channels: {
      whatsapp: { enabled: true, dmPolicy: "pairing" },
    },
  });

export function createUpdateCliConfigFixtures({
  baseConfig,
  baseSnapshot,
  readConfigFileSnapshot,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  createCaseDir,
}: {
  baseConfig: OpenClawConfig;
  baseSnapshot: ConfigFileSnapshot;
  readConfigFileSnapshot: typeof ReadConfigFileSnapshot;
  syncPluginsForUpdateChannel: Mock;
  updateNpmInstalledPlugins: Mock;
  createCaseDir: (prefix: string) => string;
}) {
  const mockNpmPluginOutcomes = (
    outcomes: unknown[],
    changed = false,
    config: OpenClawConfig = baseConfig,
  ) => {
    updateNpmInstalledPlugins.mockResolvedValueOnce({ changed, config, outcomes });
  };

  const mockNoopPostUpdatePluginConvergence = () => {
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => pluginSyncResult(config));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );
  };

  const mockPostDoctorSnapshot = (
    configPath: string,
    config: OpenClawConfig,
    options: { preserveParsed?: boolean } = {},
  ) => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      path: configPath,
      ...(options.preserveParsed ? {} : { parsed: config }),
      sourceConfig: config,
      config,
      runtimeConfig: config,
      hash: "post-doctor-hash",
    });
  };

  const configSnapshot = (
    config: OpenClawConfig,
    overrides: Partial<ConfigFileSnapshot> = {},
  ): ConfigFileSnapshot => ({
    ...baseSnapshot,
    parsed: config,
    resolved: config,
    sourceConfig: config,
    config,
    runtimeConfig: config,
    ...overrides,
  });

  const useFileBackedConfig = async (): Promise<void> => {
    const configPath = resolveConfigPath();
    const previous = await fs.readFile(configPath, "utf8").catch((error: unknown) => {
      if (!isMissingPathError(error)) {
        throw error;
      }
      return undefined;
    });
    onTestFinished(async () => {
      if (previous === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, previous);
      }
    });
    const raw = "{}\n";
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, raw, { mode: 0o600 });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot(baseConfig, {
        path: configPath,
        raw,
        hash: createHash("sha256").update(raw).digest("hex"),
      }),
    );
  };

  const setupPostCoreConfigFixture = async (params: {
    backupConfig?: OpenClawConfig;
    postDoctorConfig: OpenClawConfig;
    preUpdateConfig?: OpenClawConfig;
    snapshotSuffix?: ".bak" | ".pre-update";
    preserveParsed?: boolean;
  }) => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.mkdir(tempDir, { recursive: true });
    if (params.preUpdateConfig) {
      await writeJsonFixture(
        `${configPath}${params.snapshotSuffix ?? ".pre-update"}`,
        params.preUpdateConfig,
      );
    }
    if (params.backupConfig) {
      await writeJsonFixture(`${configPath}.bak`, params.backupConfig);
    }
    await writeJsonFixture(configPath, params.postDoctorConfig);
    mockPostDoctorSnapshot(configPath, params.postDoctorConfig, {
      preserveParsed: params.preserveParsed,
    });
    mockNoopPostUpdatePluginConvergence();
    return { tempDir, configPath };
  };
  return {
    mockNpmPluginOutcomes,
    mockNoopPostUpdatePluginConvergence,
    mockPostDoctorSnapshot,
    configSnapshot,
    useFileBackedConfig,
    setupPostCoreConfigFixture,
  };
}
