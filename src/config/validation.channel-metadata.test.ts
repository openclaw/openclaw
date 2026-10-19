import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture as plugin } from "../plugins/plugin-metadata.test-support.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({ diagnostics: [], plugins: [] })),
);

function registry(...plugins: PluginManifestRecord[]): PluginManifestRegistry {
  return { diagnostics: [], plugins };
}

function install(...plugins: Parameters<typeof plugin>[0][]) {
  mockLoadPluginManifestRegistry.mockReturnValue(registry(...plugins.map(plugin)));
}

function validatedConfig(result: ReturnType<typeof validateConfigObjectWithPlugins>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected valid config");
  }
  return result.config;
}

const objectSchema = (
  properties: Record<string, unknown>,
  options: Record<string, unknown> = {},
) => ({ type: "object", properties, additionalProperties: false, ...options });

function feishuPlugin(schema: Record<string, unknown> = objectSchema({}), id = "openclaw-lark") {
  return plugin({
    id,
    origin: "global",
    channels: ["feishu"],
    channelConfigs: { feishu: { schema, uiHints: {} } },
  });
}

function validateFeishu(config: Record<string, unknown>) {
  return validateConfigObjectRawWithPlugins({ channels: { feishu: config } });
}

function pluginDefaultsRegistry() {
  return registry(
    plugin({
      id: "opik",
      configSchema: objectSchema(
        { workspace: { type: "string", default: "default-workspace" } },
        { required: ["workspace"], additionalProperties: true },
      ),
    }),
  );
}

const enabledOpik = { plugins: { allow: ["opik"], entries: { opik: { enabled: true } } } };

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => mockLoadPluginManifestRegistry(),
  resolveManifestContractPluginIds: () => [],
}));
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => mockLoadPluginManifestRegistry(),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => ({ manifestRegistry: mockLoadPluginManifestRegistry() }),
  resolvePluginMetadataSnapshot: () => ({ manifestRegistry: mockLoadPluginManifestRegistry() }),
}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectDoctorConfigRepairPluginIds: () => [],
  collectRelevantDoctorPluginIds: () => [],
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));
vi.mock("../secrets/target-registry-data.js", () => ({
  buildSecretTargetRegistryFromPlugins: () => [],
  getCoreSecretTargetRegistry: () => [],
  getSecretTargetRegistry: () => [],
}));
vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: () => [],
}));
vi.mock("./zod-schema.js", () => ({
  OpenClawSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  mockLoadPluginManifestRegistry.mockReset().mockReturnValue(registry());
});

describe("config validation metadata", () => {
  it("loads catalog defaults before materialization when plugin validation is skipped", () => {
    const source = {
      plugins: { enabled: true },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://models.example/v1",
            models: [{ id: "vision-model", name: "Authored model", contextWindow: 64_000 }],
          },
        },
      },
    };
    const original = structuredClone(source);
    const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
    const catalogModel = {
      id: "vision-model",
      name: "Catalog model",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost,
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const expectedModel = {
      ...structuredClone(catalogModel),
      name: "Authored model",
      contextWindow: 64_000,
    };
    install({
      id: "fixture",
      providers: ["fixture"],
      modelCatalog: {
        providers: { fixture: { models: [catalogModel] } },
      },
    });
    const result = validateConfigObjectWithPlugins(source, { pluginValidation: "skip" });
    expect(validatedConfig(result).models?.providers?.fixture?.models).toMatchObject([
      expectedModel,
    ]);
    expect(source).toEqual(original);
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledOnce();
  });

  it("applies channel schema defaults even in raw mode", () => {
    install({
      id: "telegram",
      channels: ["telegram"],
      channelCatalogMeta: { id: "telegram", label: "Telegram", blurb: "Telegram channel" },
      channelConfigs: {
        telegram: {
          schema: objectSchema(
            { dmPolicy: { type: "string", enum: ["pairing", "allowlist"], default: "pairing" } },
            { additionalProperties: true },
          ),
          uiHints: {},
        },
      },
    });
    expect(
      validatedConfig(validateConfigObjectRawWithPlugins({ channels: { telegram: {} } })).channels
        ?.telegram?.dmPolicy,
    ).toBe("pairing");
  });

  it("normalizes composed local references without changing shared definitions", () => {
    const schema = objectSchema({
      accounts: {
        type: "object",
        properties: { default: { $ref: "#/$defs/Account" } },
        patternProperties: { "^work-": { $ref: "#/$defs/Account" } },
        additionalProperties: { $ref: "#/$defs/Account" },
      },
    });
    const external = {
      $ref: "#/$defs/Root",
      $defs: { Root: { anyOf: [schema] }, Account: objectSchema({}) },
    };
    const original = structuredClone(external);
    install(feishuPlugin(external));
    const config = {
      heartbeatVisibility: { showOk: true },
      accounts: {
        default: { heartbeatVisibility: { showOk: true } },
        "work-qa": { heartbeatVisibility: { useIndicator: false } },
        work: { heartbeatVisibility: { showAlerts: false } },
      },
    };
    expect(validateFeishu(config).ok).toBe(true);
    expect(
      validateFeishu({
        ...config,
        accounts: { work: { heartbeatVisibility: { showAlerts: 0 } } },
      }).ok,
    ).toBe(false);
    expect(external).toEqual(original);
  });

  it("replaces stale heartbeat declarations while preserving open custom fields", () => {
    const schema = objectSchema(
      {
        heartbeatVisibility: false,
        accounts: { type: "object", additionalProperties: true },
      },
      { additionalProperties: true },
    );
    install(feishuPlugin(schema));
    const base = {
      customChannelField: true,
      heartbeatVisibility: { showOk: true },
      accounts: { work: { customAccountField: true, heartbeatVisibility: { showAlerts: false } } },
    };
    expect(validateFeishu(base).ok).toBe(true);
    for (const config of [
      { ...base, heartbeatVisibility: "enabled" },
      { ...base, accounts: { work: { heartbeatVisibility: { showOk: "yes" } } } },
    ]) {
      expect(validateFeishu(config).ok).toBe(false);
    }
  });

  it("keeps schema ownership when closer root metadata shadows a later schema", () => {
    install(
      feishuPlugin(objectSchema({}), "openclaw" + String.fromCharCode(10, 27) + "[31m-lark"),
      plugin({ id: "workspace-channel-labels", origin: "workspace", channels: ["feishu"] }),
      feishuPlugin(objectSchema({ otherField: { type: "string" } }), "other-global-feishu"),
    );
    const result = validateFeishu({ unsupportedField: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.feishu",
          message:
            'invalid config for plugin openclaw-lark: must not have additional properties: "unsupportedField"',
        }),
      );
      expect(result.issues.map((issue) => issue.message)).not.toContain(
        'invalid config for plugin other-global-feishu: must not have additional properties: "unsupportedField"',
      );
    }
  });

  it.each([false, true])("materializes plugin defaults only in normal mode=%s", (materialized) => {
    const loadPluginMetadataSnapshot = vi.fn(() => ({
      manifestRegistry: pluginDefaultsRegistry(),
    }));
    if (!materialized) {
      mockLoadPluginManifestRegistry.mockReturnValue(pluginDefaultsRegistry());
    }
    const result = materialized
      ? validateConfigObjectWithPlugins(enabledOpik, { loadPluginMetadataSnapshot })
      : validateConfigObjectRawWithPlugins({ plugins: { entries: { opik: { enabled: true } } } });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledTimes(Number(materialized));
    if (materialized) {
      expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    }
    expect(validatedConfig(result).plugins?.entries?.opik?.config).toEqual(
      materialized ? { workspace: "default-workspace" } : undefined,
    );
  });
});
