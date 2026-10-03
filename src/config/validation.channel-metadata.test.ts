import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({ diagnostics: [], plugins: [] })),
);

function plugin(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    origin: "bundled",
    providers: [],
    skills: [],
    manifestPath: "/tmp/" + overrides.id + "/openclaw.plugin.json",
    rootDir: "/tmp/" + overrides.id,
    source: "/tmp/" + overrides.id + "/index.js",
    ...overrides,
  };
}

function registry(...plugins: PluginManifestRecord[]): PluginManifestRegistry {
  return { diagnostics: [], plugins };
}

function accountSchema() {
  return { type: "object", properties: { appId: { type: "string" } }, additionalProperties: false };
}

function feishuSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      appId: { type: "string" },
      appSecret: { type: "string" },
      replyMode: { type: "string", enum: ["thread", "direct"] },
      footer: { type: "string" },
      accounts: { type: "object", additionalProperties: accountSchema() },
    },
    required: ["appId", "appSecret"],
    additionalProperties: false,
  };
}

function feishuPlugin(schema = feishuSchema(), id = "openclaw-lark") {
  return plugin({
    id,
    origin: "global",
    channels: ["feishu"],
    channelConfigs: { feishu: { schema, uiHints: {} } },
  });
}

function validateFeishu(config: Record<string, unknown>) {
  return validateConfigObjectRawWithPlugins({
    channels: { feishu: { appId: "app-id", appSecret: "secret", ...config } },
  });
}

function pluginDefaultsRegistry() {
  return registry(
    plugin({
      id: "opik",
      configSchema: {
        type: "object",
        properties: { workspace: { type: "string", default: "default-workspace" } },
        required: ["workspace"],
        additionalProperties: true,
      },
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
    mockLoadPluginManifestRegistry.mockReturnValue(
      registry(
        plugin({
          id: "fixture",
          providers: ["fixture"],
          modelCatalog: {
            providers: {
              fixture: {
                models: [
                  {
                    id: "vision-model",
                    name: "Catalog model",
                    reasoning: true,
                    input: ["text", "image"],
                    cost,
                    contextWindow: 128_000,
                    maxTokens: 16_000,
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    const result = validateConfigObjectWithPlugins(source, { pluginValidation: "skip" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models?.providers?.fixture?.models).toMatchObject([
        {
          id: "vision-model",
          name: "Authored model",
          reasoning: true,
          input: ["text", "image"],
          cost,
          contextWindow: 64_000,
          maxTokens: 16_000,
        },
      ]);
    }
    expect(source).toEqual(original);
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledOnce();
  });

  it("applies channel schema defaults even in raw mode", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      registry(
        plugin({
          id: "telegram",
          channels: ["telegram"],
          channelCatalogMeta: { id: "telegram", label: "Telegram", blurb: "Telegram channel" },
          channelConfigs: {
            telegram: {
              schema: {
                type: "object",
                properties: {
                  dmPolicy: { type: "string", enum: ["pairing", "allowlist"], default: "pairing" },
                },
                additionalProperties: true,
              },
              uiHints: {},
            },
          },
        }),
      ),
    );
    const result = validateConfigObjectRawWithPlugins({ channels: { telegram: {} } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.channels?.telegram?.dmPolicy).toBe("pairing");
    }
  });

  it("reports open-DM warnings at both channel and account scopes", () => {
    const result = validateConfigObjectWithPlugins({
      channels: {
        mattermost: {
          dmPolicy: "open",
          accounts: {
            work: {
              enabled: true,
              baseUrl: "https://chat.example.com",
              botToken: "test-token",
              dmPolicy: "open",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    for (const scope of ["channels.mattermost", "channels.mattermost.accounts.work"]) {
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: scope + ".allowFrom",
          message: expect.stringContaining(scope + '.dmPolicy="open"'),
        }),
      );
    }
  });

  it("keeps schema ownership when closer root metadata shadows a later schema", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      registry(
        feishuPlugin(),
        plugin({ id: "workspace-channel-labels", origin: "workspace", channels: ["feishu"] }),
        feishuPlugin(
          {
            type: "object",
            properties: { otherField: { type: "string" } },
            additionalProperties: false,
          },
          "other-global-feishu",
        ),
      ),
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

  it("sanitizes the schema owner in diagnostics", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      registry(
        feishuPlugin(feishuSchema(), "openclaw" + String.fromCharCode(10, 27) + "[31m-lark"),
      ),
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
    }
  });

  it("keeps raw channel validation diagnostics plugin-agnostic", () => {
    const result = validateConfigObjectRawWithPlugins({
      channels: { telegram: { groups: ["-1001234567890"] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.telegram.groups",
          message: expect.stringContaining("invalid config:"),
        }),
      );
      expect(result.issues[0]?.message).not.toContain("Telegram groups");
      expect(result.issues[0]?.message).not.toContain("openclaw doctor --fix");
    }
  });

  it("does not inject plugin config defaults in raw mode", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(pluginDefaultsRegistry());
    const result = validateConfigObjectRawWithPlugins({
      plugins: { entries: { opik: { enabled: true } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.plugins?.entries?.opik?.config).toBeUndefined();
    }
  });

  it("reuses the registry loaded for bundled allowlist compatibility", () => {
    mockLoadPluginManifestRegistry.mockReturnValue(
      registry(
        plugin({ id: "opik", configSchema: { type: "object", additionalProperties: true } }),
        plugin({ id: "brave-search", contracts: { webSearchProviders: ["brave"] } }),
      ),
    );
    expect(validateConfigObjectWithPlugins(enabledOpik).ok).toBe(true);
    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledOnce();
  });

  it("loads a metadata snapshot once and applies its plugin defaults", () => {
    const loadPluginMetadataSnapshot = vi.fn((_config: unknown) => ({
      manifestRegistry: pluginDefaultsRegistry(),
    }));
    const result = validateConfigObjectWithPlugins(enabledOpik, { loadPluginMetadataSnapshot });
    expect(result.ok).toBe(true);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.config.plugins?.entries?.opik?.config).toEqual({
        workspace: "default-workspace",
      });
    }
  });
});
