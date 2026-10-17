import { beforeEach, expect, it, vi } from "vitest";
import * as configIo from "../config/io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { loadGatewayStartupConfigSnapshot } from "./server-startup-config.js";
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
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: OpenClawConfig }) => applyPluginAutoEnable(params),
}));

const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture();
const configPath = "/tmp/openclaw-startup-recovery.json";
const validConfig: OpenClawConfig = { gateway: { mode: "local" } };

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

function mockSnapshot(config: OpenClawConfig, overrides: Partial<ConfigFileSnapshot> = {}) {
  vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
    snapshot: snapshot(config, overrides),
    pluginMetadataSnapshot,
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

beforeEach(() => {
  vi.clearAllMocks();
  configMode.nix = configMode.readOnly = false;
  vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata)
    .mockReset()
    .mockResolvedValue({ snapshot: snapshot(), pluginMetadataSnapshot });
});

it("preserves materialized provider overlays and empty model allowlists after auto-enable", async () => {
  const defaults = { model: "anthropic/test", models: { "anthropic/test": {} } };
  const sourceConfig = {
    agents: { defaults },
    models: { providers: { anthropic: { apiKey: "test-api-key" } } },
    channels: { telegram: { botToken: "test-token" } },
  } as OpenClawConfig;
  const runtimeConfig: OpenClawConfig = {
    ...sourceConfig,
    models: { providers: { anthropic: { baseUrl: "", models: [], apiKey: "test-api-key" } } },
    channels: { telegram: { ...sourceConfig.channels?.telegram, dmPolicy: "pairing" } },
  };
  mockSnapshot(sourceConfig, { runtimeConfig, config: runtimeConfig });
  applyPluginAutoEnable.mockReturnValueOnce({
    config: {
      ...sourceConfig,
      channels: { telegram: { ...sourceConfig.channels?.telegram, enabled: true } },
      plugins: { entries: { anthropic: { enabled: true } } },
    },
    changes: ["Telegram configured, enabled automatically."],
    autoEnabledReasons: {},
  });
  const { snapshot: result } = await loadStartup({ minimalTestGateway: false });
  expect(result.runtimeConfig).toEqual({
    ...runtimeConfig,
    channels: { telegram: { ...runtimeConfig.channels?.telegram, enabled: true } },
    plugins: { entries: { anthropic: { enabled: true } } },
  });
  expect(result.config).toBe(result.runtimeConfig);
  expect(result.sourceConfig).toBe(sourceConfig);
  expect(result.sourceConfig.models?.providers?.anthropic).toEqual({
    apiKey: "test-api-key",
  });
  expectAutoEnableSource(sourceConfig);
  expect(runtimeConfig.channels?.telegram?.enabled).toBeUndefined();
  expect(configIo.writeConfigFile).not.toHaveBeenCalled();
});

it("reuses a CLI preflight snapshot without rereading config", async () => {
  const initialSnapshotRead = { snapshot: snapshot(), pluginMetadataSnapshot };
  await expect(loadStartup({ minimalTestGateway: false, initialSnapshotRead })).resolves.toEqual(
    initialSnapshotRead,
  );
  expect(configIo.readConfigFileSnapshotWithPluginMetadata).not.toHaveBeenCalled();
  expectAutoEnableSource(validConfig);
});

it("preserves storage read failures without invalid-config repair guidance", async () => {
  mockSnapshot(validConfig, {
    valid: false,
    issues: [{ path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" }],
  });
  const start = loadStartup();
  await expect(start).rejects.toMatchObject({ code: "CONFIG_READ_FAILED" });
  await expect(start).rejects.not.toThrow("doctor --fix");
  expect(applyPluginAutoEnable).not.toHaveBeenCalled();
  expect(configIo.writeConfigFile).not.toHaveBeenCalled();
});

it.each([false, true])("selects packaging recovery (core invalid: %s)", async (coreInvalid) => {
  const config: OpenClawConfig = { plugins: { slots: { memory: "source-only-pack" } } };
  mockSnapshot(config, {
    valid: false,
    issues: [
      { path: "plugins.slots.memory", message: "plugin not found: source-only-pack" },
      ...(coreInvalid ? [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }] : []),
    ],
    warnings: [
      {
        path: "plugins",
        message:
          "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
      },
    ],
  });
  const start = loadStartup();
  if (coreInvalid) {
    await expect(start).rejects.toThrow('Run "openclaw doctor --fix" to repair, then retry.');
  } else {
    await expect(start).rejects.toThrow(
      `Invalid config at ${configPath}:\nplugins.slots.memory: plugin not found: source-only-pack\nThis is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.`,
    );
    await expect(start).rejects.not.toThrow("openclaw doctor --fix");
  }
});

it.each(["Nix", "read-only"])("rejects legacy config entries in %s mode", async (mode) => {
  const issues = [{ path: "session.typingMode", message: "Legacy config entry" }];
  mockSnapshot({}, { valid: false, issues, legacyIssues: issues });
  configMode.nix = mode === "Nix";
  configMode.readOnly = true;
  await expect(loadStartup()).rejects.toThrow(
    mode === "Nix"
      ? "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart."
      : "Legacy config entries detected in read-only config. Update your external config source to the latest schema and restart.",
  );
});
