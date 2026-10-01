import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { ModelProviderConfigInput } from "../config/types.models.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: OpenClawConfig }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const configMode = vi.hoisted(() => ({ nix: false, readOnly: false }));
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  writeConfigFile: vi.fn(),
}));
vi.mock("../config/paths.js", () => ({
  resolveIsConfigReadOnly: () => configMode.nix || configMode.readOnly,
  get isNixMode() {
    return configMode.nix;
  },
  resolveStateDir: vi.fn(() => "/tmp/openclaw-state"),
}));
vi.mock("../config/runtime-overrides.js", () => ({
  applyConfigOverrides: vi.fn((config: OpenClawConfig) => config),
}));
vi.mock("../config/mutate.js", () => ({ replaceConfigFile: vi.fn() }));
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: OpenClawConfig }) => applyPluginAutoEnable(params),
}));

let loadGatewayStartupConfigSnapshot: typeof import("./server-startup-config.js").loadGatewayStartupConfigSnapshot;
let configIo: typeof import("../config/io.js");
let configMutate: typeof import("../config/mutate.js");
const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
const configPath = "/tmp/openclaw-startup-recovery.json";
const validConfig: OpenClawConfig = { gateway: { mode: "local" } };
const autoEnableChange = "Telegram configured, enabled automatically.";

function snapshot(
  config: OpenClawConfig = validConfig,
  overrides: Partial<ConfigFileSnapshot> = {},
): ConfigFileSnapshot {
  return {
    ...buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      valid: true,
      config,
      issues: [],
      legacyIssues: [],
    }),
    ...overrides,
  };
}

function mockSnapshot(value: ConfigFileSnapshot) {
  vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
    snapshot: value,
    pluginMetadataSnapshot,
  });
}

function autoEnable(config: OpenClawConfig) {
  applyPluginAutoEnable.mockReturnValueOnce({
    config,
    changes: [autoEnableChange],
    autoEnabledReasons: {},
  });
}

function loadStartup(
  options: Partial<Parameters<typeof loadGatewayStartupConfigSnapshot>[0]> = {},
) {
  return loadGatewayStartupConfigSnapshot({
    minimalTestGateway: true,
    ambientEnvTriggers: "suppress",
    log: { info: vi.fn(), warn: vi.fn() },
    ...options,
  });
}

function expectAutoEnableSource(config: OpenClawConfig) {
  expect(applyPluginAutoEnable).toHaveBeenCalledWith({
    config,
    env: process.env,
    ambientEnvTriggers: "suppress",
    manifestRegistry: pluginMetadataSnapshot.manifestRegistry,
  });
}

describe("gateway startup config validation", () => {
  beforeAll(async () => {
    ({ loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js"));
    configIo = await import("../config/io.js");
    configMutate = await import("../config/mutate.js");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    configMode.nix = configMode.readOnly = false;
    vi.mocked(configIo.readConfigFileSnapshot).mockReset().mockResolvedValue(snapshot());
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata)
      .mockReset()
      .mockImplementation(async () => {
        const value = await configIo.readConfigFileSnapshot();
        return value.valid ? { snapshot: value, pluginMetadataSnapshot } : { snapshot: value };
      });
    vi.mocked(configIo.writeConfigFile).mockReset().mockResolvedValue({
      persistedHash: "test-persisted-hash",
      persistedConfig: validConfig,
    });
  });

  it("preserves materialized provider overlays and empty model allowlists after auto-enable", async () => {
    const overlay: ModelProviderConfigInput = { apiKey: "test-api-key" };
    const sourceConfig = {
      gateway: { mode: "local" },
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          models: { "anthropic/claude-sonnet-4-6": {} },
        },
      },
      models: { providers: { anthropic: overlay } },
      channels: { telegram: { botToken: "test-token" } },
    } as OpenClawConfig;
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      agents: { defaults: { ...sourceConfig.agents?.defaults, compaction: { mode: "safeguard" } } },
      models: { providers: { anthropic: { baseUrl: "", models: [], apiKey: "test-api-key" } } },
      channels: { telegram: { ...sourceConfig.channels?.telegram, dmPolicy: "pairing" } },
      messages: { ackReactionScope: "group-mentions" },
    };
    mockSnapshot(snapshot(sourceConfig, { runtimeConfig, config: runtimeConfig }));
    autoEnable({
      ...sourceConfig,
      channels: { telegram: { ...sourceConfig.channels?.telegram, enabled: true } },
      plugins: { entries: { anthropic: { enabled: true } } },
    });
    const result = await loadStartup({ minimalTestGateway: false });
    expect(result.snapshot.runtimeConfig).toEqual({
      ...runtimeConfig,
      channels: { telegram: { ...runtimeConfig.channels?.telegram, enabled: true } },
      plugins: { entries: { anthropic: { enabled: true } } },
    });
    expect(result.snapshot.config).toBe(result.snapshot.runtimeConfig);
    expect(result.snapshot.sourceConfig).toBe(sourceConfig);
    expect(result.snapshot.sourceConfig.models?.providers?.anthropic).toEqual({
      apiKey: "test-api-key",
    });
    expect(result.snapshot.runtimeConfig.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {},
    });
    expectAutoEnableSource(sourceConfig);
    expect(runtimeConfig.channels?.telegram?.enabled).toBeUndefined();
    expect(configIo.writeConfigFile).not.toHaveBeenCalled();
    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("reuses a CLI preflight snapshot without rereading config", async () => {
    const initialSnapshotRead = { snapshot: snapshot(), pluginMetadataSnapshot };
    await expect(loadStartup({ minimalTestGateway: false, initialSnapshotRead })).resolves.toEqual(
      initialSnapshotRead,
    );
    expect(configIo.readConfigFileSnapshotWithPluginMetadata).not.toHaveBeenCalled();
    expectAutoEnableSource(validConfig);
  });

  it("keeps plugin auto-enable runtime-only in Nix mode", async () => {
    const config: OpenClawConfig = {
      channels: { telegram: { botToken: "test-token" } },
      gateway: { mode: "local" },
    };
    const activated = { ...config, plugins: { allow: ["telegram"] } };
    const initial = snapshot(config);
    mockSnapshot(initial);
    autoEnable(activated);
    configMode.nix = true;
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(loadStartup({ minimalTestGateway: false, log })).resolves.toEqual({
      snapshot: { ...initial, runtimeConfig: activated, config: activated },
      pluginMetadataSnapshot,
    });
    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      `gateway: auto-enabled plugins for this runtime without writing config:\n- ${autoEnableChange}`,
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("preserves storage read failures without invalid-config repair guidance", async () => {
    mockSnapshot(
      snapshot(validConfig, {
        valid: false,
        issues: [{ path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" }],
      }),
    );
    const start = loadStartup();
    await expect(start).rejects.toMatchObject({ code: "CONFIG_READ_FAILED" });
    await expect(start).rejects.not.toThrow("doctor --fix");
    expect(applyPluginAutoEnable).not.toHaveBeenCalled();
    expect(configIo.writeConfigFile).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "selects packaging recovery guidance (core invalidity: %s)",
    async (coreInvalid) => {
      const config: OpenClawConfig = { plugins: { slots: { memory: "source-only-pack" } } };
      mockSnapshot(
        snapshot(config, {
          valid: false,
          issues: [
            { path: "plugins.slots.memory", message: "plugin not found: source-only-pack" },
            ...(coreInvalid
              ? [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }]
              : []),
          ],
          warnings: [
            {
              path: "plugins",
              message:
                "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
            },
          ],
        }),
      );
      const start = loadStartup();
      if (coreInvalid) {
        await expect(start).rejects.toThrow('Run "openclaw doctor --fix" to repair, then retry.');
      } else {
        await expect(start).rejects.toThrow(
          `Invalid config at ${configPath}:\nplugins.slots.memory: plugin not found: source-only-pack\nThis is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.`,
        );
        await expect(start).rejects.not.toThrow("openclaw doctor --fix");
      }
    },
  );

  it.each(["Nix", "read-only"])("rejects legacy config entries in %s mode", async (mode) => {
    const issues = [
      {
        path: "session.typingMode",
        message:
          'session.typingMode moved to agents.defaults.typingMode. Run "openclaw doctor --fix".',
      },
    ];
    mockSnapshot(
      snapshot(
        {},
        {
          raw: '{"session":{"typingMode":"thinking"}}\n',
          parsed: { session: { typingMode: "thinking" } },
          valid: false,
          issues,
          legacyIssues: issues,
        },
      ),
    );
    configMode.nix = mode === "Nix";
    configMode.readOnly = true;
    await expect(loadStartup()).rejects.toThrow(
      mode === "Nix"
        ? "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart."
        : "Legacy config entries detected in read-only config. Update your external config source to the latest schema and restart.",
    );
  });
});
