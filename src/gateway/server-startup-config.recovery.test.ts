import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: OpenClawConfig }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const pluginManifestRegistry = vi.hoisted(() => ({ plugins: [], diagnostics: [] }));
const pluginMetadataSnapshot = vi.hoisted(
  (): PluginMetadataSnapshot => ({
    policyHash: "policy",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: pluginManifestRegistry,
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  }),
);

vi.mock("../config/config.js", () => ({
  applyConfigOverrides: vi.fn((config: OpenClawConfig) => config),
  isNixMode: false,
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  isPluginLocalInvalidConfigSnapshot: vi.fn((snapshot: ConfigFileSnapshot) => {
    if (snapshot.valid || snapshot.legacyIssues.length > 0 || snapshot.issues.length === 0) {
      return false;
    }
    return snapshot.issues.every((issue) => issue.path.startsWith("plugins.entries."));
  }),
  replaceConfigFile: vi.fn(),
  shouldAttemptLastKnownGoodRecovery: vi.fn((snapshot: ConfigFileSnapshot) => {
    if (snapshot.valid) {
      return false;
    }
    return !(
      snapshot.legacyIssues.length === 0 &&
      snapshot.issues.length > 0 &&
      snapshot.issues.every((issue) => issue.path.startsWith("plugins.entries."))
    );
  }),
  validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  })),
  writeConfigFile: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: OpenClawConfig }) => applyPluginAutoEnable(params),
}));

vi.mock("./config-recovery-notice.js", () => ({
  enqueueConfigRecoveryNotice: vi.fn(),
}));

let loadGatewayStartupConfigSnapshot: typeof import("./server-startup-config.js").loadGatewayStartupConfigSnapshot;
let configIo: typeof import("../config/config.js");
let recoveryNotice: typeof import("./config-recovery-notice.js");

const configPath = "/tmp/openclaw-startup-recovery.json";
const validConfig = {
  gateway: {
    mode: "local",
  },
} as OpenClawConfig;

function buildSnapshot(params: {
  valid: boolean;
  raw: string;
  config?: OpenClawConfig;
}): ConfigFileSnapshot {
  return buildTestConfigSnapshot({
    path: configPath,
    exists: true,
    raw: params.raw,
    parsed: params.config ?? null,
    valid: params.valid,
    config: params.config ?? ({} as OpenClawConfig),
    issues: params.valid ? [] : [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
    legacyIssues: [],
  });
}

describe("gateway startup config recovery", () => {
  beforeAll(async () => {
    ({ loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js"));
    configIo = await import("../config/config.js");
    recoveryNotice = await import("./config-recovery-notice.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockImplementation(async () => ({
      snapshot: await vi.mocked(configIo.readConfigFileSnapshot)(),
    }));
  });

  it("runs startup plugin auto-enable against source config without persisting runtime defaults", async () => {
    const sourceConfig = {
      browser: { enabled: false },
      gateway: { mode: "local" },
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          browser: { enabled: false },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      plugins: {
        ...sourceConfig.plugins,
        entries: {
          ...sourceConfig.plugins?.entries,
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const snapshot = {
      ...buildTestConfigSnapshot({
        path: configPath,
        exists: true,
        raw: `${JSON.stringify(sourceConfig)}\n`,
        parsed: sourceConfig,
        valid: true,
        config: runtimeConfig,
        issues: [],
        legacyIssues: [],
      }),
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig,
      config: runtimeConfig,
    } satisfies ConfigFileSnapshot;
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
      snapshot,
      pluginMetadataSnapshot,
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toEqual({
      snapshot,
      wroteConfig: false,
      pluginMetadataSnapshot,
    });

    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(configIo.replaceConfigFile).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("restores last-known-good config before startup validation", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    const recoveredSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(recoveredSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: recoveredSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromLastKnownGood).toHaveBeenCalledWith({
      snapshot: invalidSnapshot,
      reason: "startup-invalid-config",
    });
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was restored from last-known-good backup: ${configPath}`,
    );
    expect(recoveryNotice.enqueueConfigRecoveryNotice).toHaveBeenCalledWith({
      cfg: recoveredSnapshot.config,
      phase: "startup",
      reason: "startup-invalid-config",
      configPath,
    });
  });

  it("keeps startup validation loud when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(false);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      `Invalid config at ${configPath}.\ngateway.mode: Expected 'local' or 'remote'\nRun "openclaw doctor --fix" to repair, then retry.`,
    );

    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("continues startup in degraded mode for plugin-local startup invalidity", async () => {
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      })}\n`,
      parsed: {
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      },
      valid: false,
      config: {
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      } as OpenClawConfig,
      issues: [
        {
          path: "plugins.entries.feishu",
          message:
            "plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load",
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: expect.objectContaining({
        valid: true,
        issues: [],
        warnings: invalidSnapshot.issues,
      }),
      wroteConfig: false,
      degradedPluginConfig: true,
    });

    expect(configIo.recoverConfigFromLastKnownGood).not.toHaveBeenCalled();
    expect(configIo.recoverConfigFromJsonRootSuffix).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: skipped plugin config validation issue at plugins.entries.feishu: plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load. Run "openclaw doctor --fix" to quarantine the plugin config.`,
    );
    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("keeps mixed plugin and core startup invalidity fatal", async () => {
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify({
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      })}\n`,
      parsed: {
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      },
      valid: false,
      config: {
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      } as unknown as OpenClawConfig,
      issues: [
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
        {
          path: "plugins.entries.feishu.config.token",
          message: "invalid config: must be string",
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(false);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);

    expect(configIo.recoverConfigFromLastKnownGood).toHaveBeenCalledWith({
      snapshot: invalidSnapshot,
      reason: "startup-invalid-config",
    });
  });

  it("skips providers with stale model api enum values during startup", async () => {
    const config = {
      gateway: { mode: "local" },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai",
            models: [
              {
                id: "openai/gpt-4o-mini",
                name: "OpenRouter GPT-4o Mini",
                api: "openai",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      valid: false,
      config,
      issues: [
        {
          path: "models.providers.openrouter.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-codex-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
        {
          path: "models.providers.openrouter.models.0.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-codex-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log,
    });

    expect(result.wroteConfig).toBe(false);
    expect(result.degradedProviderApi).toBe(true);
    expect(result.snapshot.valid).toBe(true);
    expect(result.snapshot.sourceConfig.models?.providers?.openrouter).toBeUndefined();
    expect(result.snapshot.sourceConfig.models?.providers?.anthropic).toEqual(
      config.models?.providers?.anthropic,
    );
    expect(configIo.recoverConfigFromLastKnownGood).not.toHaveBeenCalled();
    expect(configIo.writeConfigFile).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'gateway: skipped model provider openrouter; configured provider api is invalid. Run "openclaw doctor --fix" to repair the config.',
    );
  });

  it("strips a valid JSON suffix when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({
      valid: false,
      raw: `Found and updated: False\n${JSON.stringify(validConfig)}\n`,
    });
    const repairedSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(repairedSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: repairedSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromJsonRootSuffix).toHaveBeenCalledWith(invalidSnapshot);
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was repaired by stripping a non-JSON prefix: ${configPath}`,
    );
  });
});
