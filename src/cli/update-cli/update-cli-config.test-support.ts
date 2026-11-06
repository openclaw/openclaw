import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi, type Mock } from "vitest";
import type { runPostCorePluginConvergence } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import type { readConfigFileSnapshot as ReadConfigFileSnapshot } from "../../config/config.js";
import { resolveConfigPath } from "../../config/paths.js";
import type {
  OpenClawConfig,
  ConfigFileSnapshot,
  ConfigValidationIssue,
} from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { writeJsonFixture } from "./update-cli-package.test-support.js";
import type { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

type PostCoreUpdateOptions = Parameters<typeof completePostCorePluginUpdate>[0];

export function createChangedPostCoreUpdateOptions(
  overrides: Partial<PostCoreUpdateOptions> = {},
): PostCoreUpdateOptions {
  return {
    root: "/tmp/openclaw-updated-root",
    pluginUpdate: createPostCorePluginUpdateResult({
      status: "ok",
      changed: true,
      warnings: [],
      npm: { changed: true, outcomes: [] },
    }),
    yes: true,
    json: true,
    timeoutMs: 30_000,
    ...overrides,
  };
}

export function createConfigValidationFailure(
  issues: readonly ConfigValidationIssue[],
  message = "config invalid",
) {
  // Match the CLI issue envelope and an ordinary completed Execa failure.
  return Object.assign(new Error(message), {
    failed: true,
    exitCode: 1,
    stdout: JSON.stringify({ valid: false, issues }),
  });
}

export function createUpdateCliBaseSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return createTestConfigSnapshot(config, config, "/tmp/openclaw-config.json");
}

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
  configChanges: [],
  installedPluginIdRecovery: new Map(),
  changes: [],
  warnings: [],
  errored: false,
  smokeFailures: [],
  installRecords: {},
  ...overrides,
});

/** Return each call's config while overriding only the scenario's convergence outcome. */
export function mockPostCoreConvergenceOnce(
  spy: Pick<Mock<typeof runPostCorePluginConvergence>, "mockImplementationOnce">,
  overrides: Partial<Awaited<ReturnType<typeof runPostCorePluginConvergence>>> = {},
): void {
  spy.mockImplementationOnce(async ({ cfg }) => ({
    ...postCoreConvergenceResult(),
    config: cfg,
    ...overrides,
  }));
}

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

export function createUpdateCliConfigFixtures(deps: {
  baseConfig: OpenClawConfig;
  baseSnapshot: ConfigFileSnapshot;
  readConfigFileSnapshot: typeof ReadConfigFileSnapshot;
  syncPluginsForUpdateChannel: Mock;
  updateNpmInstalledPlugins: Mock;
  createCaseDir: (prefix: string) => string;
}) {
  const fixtures = {
    mockNpmPluginOutcomes: (outcomes: unknown[], changed = false, config = deps.baseConfig) => {
      deps.updateNpmInstalledPlugins.mockResolvedValueOnce({ changed, config, outcomes });
    },
    mockNoopPostUpdatePluginConvergence: () => {
      deps.syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
        pluginSyncResult(config),
      );
      deps.updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
        npmPluginUpdateResult(config),
      );
    },
    configSnapshot: (
      config: OpenClawConfig,
      overrides: Partial<ConfigFileSnapshot> = {},
    ): ConfigFileSnapshot => {
      return {
        ...deps.baseSnapshot,
        parsed: config,
        resolved: config,
        sourceConfig: config,
        config,
        runtimeConfig: config,
        ...overrides,
      };
    },
    mockPostDoctorSnapshot: (
      configPath: string,
      config: OpenClawConfig,
      options: { preserveParsed?: boolean } = {},
    ) => {
      vi.mocked(deps.readConfigFileSnapshot).mockResolvedValue(
        fixtures.configSnapshot(config, {
          path: configPath,
          parsed: options.preserveParsed ? deps.baseSnapshot.parsed : config,
          resolved: deps.baseSnapshot.resolved,
          hash: "post-doctor-hash",
        }),
      );
    },
    useFileBackedConfig: async (): Promise<void> => {
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
      vi.mocked(deps.readConfigFileSnapshot).mockResolvedValue(
        fixtures.configSnapshot(deps.baseConfig, {
          path: configPath,
          raw,
          hash: createHash("sha256").update(raw).digest("hex"),
        }),
      );
    },
    setupPostCoreConfigFixture: async (params: {
      backupConfig?: OpenClawConfig;
      postDoctorConfig: OpenClawConfig;
      preUpdateConfig?: OpenClawConfig;
      snapshotSuffix?: ".bak" | ".pre-update";
      preserveParsed?: boolean;
    }) => {
      const tempDir = deps.createCaseDir("openclaw-update");
      const configPath = path.join(tempDir, "openclaw.json");
      await fs.mkdir(tempDir, { recursive: true });
      if (params.preUpdateConfig) {
        await writeJsonFixture(
          configPath + (params.snapshotSuffix ?? ".pre-update"),
          params.preUpdateConfig,
        );
      }
      if (params.backupConfig) {
        await writeJsonFixture(configPath + ".bak", params.backupConfig);
      }
      await writeJsonFixture(configPath, params.postDoctorConfig);
      fixtures.mockPostDoctorSnapshot(configPath, params.postDoctorConfig, {
        preserveParsed: params.preserveParsed,
      });
      fixtures.mockNoopPostUpdatePluginConvergence();
      return { tempDir, configPath };
    },
  };
  return fixtures;
}
