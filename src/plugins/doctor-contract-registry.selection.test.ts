// Covers plugin doctor selection from config and touched paths.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createLegacyWebhookListenerDoctorContract } from "../plugin-sdk/legacy-webhook-listener-migration.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

// Script contract exports at module binding while keeping setup instance ownership.
vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-instance-module-loader.js")>();
  const { getCachedPluginModuleLoader } = await import("./plugin-module-loader-cache.js");
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) =>
      params.instance.bindModuleLoader(
        getCachedPluginModuleLoader({
          modulePath: params.source,
          importerUrl: import.meta.url,
          createLoader: getRegistryJitiMocks().createJiti,
        }),
      ),
  };
});

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();
const doctorContractWarnMock = vi.hoisted(() => vi.fn());
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: doctorContractWarnMock,
    }),
  };
});

let applyPluginDoctorCompatibilityMigrations: typeof import("./doctor-contract-registry.js").applyPluginDoctorCompatibilityMigrations;
let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.test-fixtures.js").clearPluginDoctorContractRegistryCache;
let collectRelevantDoctorPluginIds: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIds;
let collectDoctorConfigRepairPluginIds: typeof import("./doctor-contract-registry.js").collectDoctorConfigRepairPluginIds;
let listPluginDoctorSessionStoreAgentIds: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionStoreAgentIds;
let withDeferredPluginDoctorMigrations: typeof import("./doctor-contract-registry.js").withDeferredPluginDoctorMigrations;

function mockDoctorPlugins(...plugins: Record<string, unknown>[]): void {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

afterEach(() => {
  clearPluginDoctorContractRegistryCache?.();
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry module loader", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      collectRelevantDoctorPluginIds,
      collectDoctorConfigRepairPluginIds,
      listPluginDoctorSessionStoreAgentIds,
      withDeferredPluginDoctorMigrations,
    } = await import("./doctor-contract-registry.js"));
    ({ clearPluginDoctorContractRegistryCache } =
      await import("./doctor-contract-registry.test-fixtures.js"));
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    mockDoctorPlugins();
    doctorContractWarnMock.mockReset();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
    clearPluginDoctorContractRegistryCache();
  });

  it.each([
    {
      name: "missing official plugin",
      ownerId: undefined,
      warning: undefined,
      explicit: false,
      pins: true,
    },
    {
      name: "authored listener endpoints",
      ownerId: undefined,
      warning: undefined,
      explicit: true,
      pins: true,
    },
    {
      name: "unresolved host facts",
      ownerId: undefined,
      warning: "Resolve account ambiguity",
      explicit: false,
      pins: false,
    },
    {
      name: "deferred installed owner",
      ownerId: "feishu",
      warning: undefined,
      explicit: false,
      pins: false,
    },
    {
      name: "deferred trusted official owner",
      ownerId: "feishu",
      trusted: true,
      warning: undefined,
      explicit: false,
      pins: true,
    },
    {
      name: "deferred trusted owner with authored endpoints",
      ownerId: "feishu",
      trusted: true,
      warning: undefined,
      explicit: true,
      pins: true,
    },
    {
      name: "deferred trusted owner excluded by the allowlist",
      ownerId: "feishu",
      trusted: true,
      restricted: true,
      warning: undefined,
      explicit: false,
      pins: false,
    },
    {
      name: "deferred replacement owner",
      ownerId: "custom-feishu",
      warning: undefined,
      explicit: false,
      pins: false,
    },
  ])("preserves historical webhook ownership for $name", (scenario) => {
    const { ownerId, trusted, restricted, warning, explicit, pins } = scenario;
    const config: OpenClawConfig = {
      meta: { migrations: { webhookListeners: { telegram: [] } } },
      gateway: { port: 18789 },
      ...(restricted ? { plugins: { allow: ["other-plugin"] } } : {}),
      channels: {
        feishu: {
          enabled: true,
          connectionMode: "webhook",
          tools: { base: true },
          ...(explicit ? { webhookPort: 9001, webhookHost: "0.0.0.0" } : {}),
          accounts: {
            default: { enabled: true },
            optedOut: { legacyWebhook: false },
            ...(explicit ? { specific: { enabled: true, webhookPort: 9002 } } : {}),
          },
        },
      },
    };
    const original = structuredClone(config);
    const listener = createLegacyWebhookListenerDoctorContract({
      channelKey: "feishu",
      defaultPort: 3000,
      defaultHost: "127.0.0.1",
    });
    retainedConfigDoctorMock.mockReturnValue({
      ...listener,
      normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
        config: { ...cfg, gateway: { ...cfg.gateway, port: 60000 } },
        changes: ["Unrelated plugin repair"],
      }),
      normalizeHistoricalWebhookConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
        ...listener.normalizeCompatibilityConfig({ cfg }),
        historicalWebhookAccountIds: ["default", "optedOut", ...(explicit ? ["specific"] : [])],
        ...(warning ? { warnings: [warning] } : {}),
      }),
    });
    if (ownerId) {
      const pluginRoot = makeTempDir();
      fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
      mocks.createJiti.mockImplementation(() => () => ({
        normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
          config: { ...cfg, gateway: { ...cfg.gateway, port: 61000 } },
          changes: ["Deferred owner ran"],
        }),
      }));
      mockDoctorPlugins({
        id: ownerId,
        rootDir: pluginRoot,
        channels: ["feishu"],
        providers: [],
        origin: "global",
        trustedOfficialInstall: trusted,
        doctorContract: { configRepair: true },
      });
    }
    const inspected = vi.fn();
    const result = withDeferredPluginDoctorMigrations([ownerId ?? "feishu"], () =>
      applyPluginDoctorCompatibilityMigrations(config, {
        config,
        env: {},
        pluginIds: ["feishu"],
        historicalWebhookListeners: true,
        onInspectedPlugin: inspected,
      }),
    );

    expect(config).toEqual(original);
    expect(result.config).toEqual(
      pins
        ? {
            ...original,
            meta: {
              migrations: {
                webhookListeners: {
                  telegram: [],
                  feishu: explicit
                    ? []
                    : [["channels", "feishu", "accounts", "default", "legacyWebhook"]],
                },
              },
            },
            channels: {
              feishu: {
                enabled: true,
                connectionMode: "webhook",
                tools: { base: true },
                ...(explicit ? { legacyWebhook: { port: 9001, host: "0.0.0.0" } } : {}),
                accounts: {
                  default: {
                    enabled: true,
                    ...(explicit ? {} : { legacyWebhook: { port: 3000, host: "127.0.0.1" } }),
                  },
                  optedOut: { legacyWebhook: false },
                  ...(explicit
                    ? {
                        specific: {
                          enabled: true,
                          legacyWebhook: { port: 9002, host: "0.0.0.0" },
                        },
                      }
                    : {}),
                },
              },
            },
          }
        : restricted
          ? {
              ...original,
              meta: { migrations: { webhookListeners: { telegram: [], feishu: [] } } },
            }
          : original,
    );
    expect(result.warnings).toEqual(warning ? [warning] : undefined);
    expect(inspected).not.toHaveBeenCalled();
    expect(mocks.createJiti).not.toHaveBeenCalled();
    if (pins) {
      expect(listener.normalizeCompatibilityConfig({ cfg: result.config })).toMatchObject({
        config: result.config,
        changes: [],
      });
    }
  });

  it.each([
    { name: "full scan", touchedPaths: undefined, configRepair: true, expected: true },
    { name: "parent edit", touchedPaths: [["legacyRoots"]], configRepair: true, expected: true },
    {
      name: "dotted owner edit",
      touchedPaths: [["legacyRoots", "store.with.dots", "root"]],
      configRepair: true,
      expected: true,
    },
    {
      name: "unrelated edit",
      touchedPaths: [["gateway", "port"]],
      configRepair: true,
      expected: false,
    },
    { name: "empty edit", touchedPaths: [], configRepair: true, expected: false },
    { name: "undeclared repair", touchedPaths: undefined, configRepair: false, expected: false },
  ])(
    "discovers declared config migration sources without plugin entries: $name",
    async ({ touchedPaths, configRepair, expected }) => {
      const pluginRoot = makeTempDir();
      fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
      const rule = {
        path: ["legacyRoots", "store.with.dots", "root"],
        message: "Migrate legacy root",
      };
      mocks.createJiti.mockImplementation(() => () => ({
        legacyConfigRules: [rule],
        resolveSessionStoreAgentIds: () => ["unexpected-owner"],
      }));
      mockDoctorPlugins({
        id: "root-owner",
        rootDir: pluginRoot,
        channels: [],
        providers: [],
        doctorContract: { configRepair, resolveSessionStoreAgentIds: true },
        configContracts: { compatibilityMigrationPaths: ["legacyRoots.*.root"] },
      });
      const raw = { legacyRoots: { "store.with.dots": { root: "/legacy/documents" } } };
      const { findDoctorLegacyConfigIssues } =
        await import("../commands/doctor/shared/legacy-config-issues.js");
      expect(findDoctorLegacyConfigIssues(raw, raw, touchedPaths)).toEqual(
        expected ? [{ path: rule.path.join("."), message: rule.message }] : [],
      );
      expect(mocks.createJiti).toHaveBeenCalledTimes(expected ? 1 : 0);
      // Config migration declarations must not select new session-store owners.
      const pluginIds = collectRelevantDoctorPluginIds(raw);
      expect(pluginIds).toEqual([]);
      expect(listPluginDoctorSessionStoreAgentIds({ pluginIds })).toEqual([]);
    },
  );

  it("collects model provider ids for doctor compatibility migrations", () => {
    expect(
      collectRelevantDoctorPluginIds({
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ai.ollama.com",
            },
          },
        },
      }),
    ).toEqual(["ollama-cloud"]);
  });

  it("collects distinct configured-model and policy providers without shadow-list owners", () => {
    expect(
      collectRelevantDoctorPluginIds({
        agents: {
          defaults: {
            model: { primary: "default/model", fallbacks: ["fallback/model", 42] },
            modelPolicy: { allow: ["default/*", "default-policy/*", 42, "bare"] },
          },
          entries: {
            worker: { model: "entry/model", modelPolicy: { allow: ["entry-policy/model", null] } },
          },
          list: [
            {
              id: "shadow",
              model: "shadow/model",
              modelPolicy: { allow: ["shadow-policy/model"] },
            },
          ],
        },
        hooks: { mappings: [{ model: "hook/model" }, { model: 42 }] },
      }),
    ).toEqual(["default", "default-policy", "entry", "entry-policy", "fallback", "hook"]);
  });

  it("collects model and policy providers from the legacy list when entries is absent", () => {
    expect(
      collectRelevantDoctorPluginIds({
        agents: {
          list: [
            {
              id: "legacy",
              model: "legacy-model/model",
              modelPolicy: { allow: ["legacy-policy/*"] },
            },
          ],
        },
      }),
    ).toEqual(["legacy-model", "legacy-policy"]);
  });

  it("does not collect shadow-list policy providers when entries is null", () => {
    expect(
      collectRelevantDoctorPluginIds({
        agents: {
          entries: null,
          list: [{ id: "shadow", modelPolicy: { allow: ["shadow-policy/*"] } }],
        },
      }),
    ).toEqual([]);
  });

  it("excludes channel metadata and blank ids from full and touched doctor scans", () => {
    const raw = {
      channels: {
        defaults: {},
        modelByChannel: { discord: { guild: "openai/gpt-5.6-luna" } },
        " ": {},
        discord: {},
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["discord", "openai"]);
    expect(
      collectDoctorConfigRepairPluginIds(raw, [["channels", "modelByChannel", "discord", "guild"]]),
    ).toStrictEqual(["openai"]);
    expect(collectDoctorConfigRepairPluginIds(raw, [["channels"]])).toEqual(["discord", "openai"]);
  });

  it("collects provider ids from media model entries", () => {
    const raw = {
      tools: {
        media: {
          models: [
            { provider: " xAI " },
            { provider: " " },
            { provider: "XAI", model: "grok-stt", capabilities: ["audio"] },
            { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
            { provider: "gemini", model: "veo", capabilities: ["video"] },
          ],
        },
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["gemini", "openai", "xai"]);
    expect(
      collectDoctorConfigRepairPluginIds(raw, [["tools", "media", "models", "2", "model"]]),
    ).toEqual(["gemini", "openai", "xai"]);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider alias", () => {
    const pluginRoot = makeTempDir();
    const unrelatedRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    fs.writeFileSync(path.join(unrelatedRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => (modulePath: string) => ({
      normalizeCompatibilityConfig: ({
        cfg,
      }: {
        cfg: { models?: { providers?: Record<string, Record<string, unknown>> } };
      }) => ({
        config: {
          ...cfg,
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              "ollama-cloud": {
                ...cfg.models?.providers?.["ollama-cloud"],
                baseUrl: "https://ollama.com",
              },
            },
          },
        },
        changes: [
          modulePath.startsWith(unrelatedRoot)
            ? "wrong unrelated provider contract"
            : "normalized ollama cloud provider endpoint",
        ],
      }),
    }));
    mockDoctorPlugins(
      {
        id: "ollama",
        rootDir: pluginRoot,
        channels: [],
        providers: ["OlLaMa"],
        providerAuthAliases: { "Ollama-Cloud": "OLLAMA" },
      },
      {
        id: "unrelated",
        rootDir: unrelatedRoot,
        channels: [],
        providers: ["unrelated"],
        providerAuthAliases: { "ollama-cloud": "missing" },
      },
    );
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ai.ollama.com",
            models: [],
          },
        },
      },
    };

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds: ["ollama-cloud"],
    });

    expect(result.changes).toEqual(["normalized ollama cloud provider endpoint"]);
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual({
      baseUrl: "https://ollama.com",
      models: [],
    });
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("loads a provider doctor contract when a media preference is its only activation", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => ({
        config: { ...cfg, repaired: true },
        changes: ["repaired configured provider model"],
      }),
    }));
    mockDoctorPlugins({
      id: "opencode",
      rootDir: pluginRoot,
      channels: [],
      providers: ["opencode"],
      doctorContract: { configRepair: true },
    });
    const config = {
      tools: { media: { image: { preferredModel: "opencode/gpt-5-nano" } } },
    };
    const pluginIds = collectRelevantDoctorPluginIds(config);

    expect(pluginIds).toEqual(["opencode"]);
    expect(
      applyPluginDoctorCompatibilityMigrations(config, { config, env: {}, pluginIds }),
    ).toEqual({
      config: { ...config, repaired: true },
      changes: ["repaired configured provider model"],
    });
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
          models: {
            providers: {
              "ollama-cloud": {},
            },
          },
          talk: {
            voiceId: "legacy-voice",
          },
        },
        [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["models", "providers", "ollama-cloud", "baseUrl"],
          ["talk", "voiceId"],
        ],
      ),
    ).toEqual(["discord", "elevenlabs", "memory-wiki", "ollama-cloud"]);
  });

  it("keeps all configured model and policy providers active during touched scans", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          agents: {
            defaults: {
              model: { primary: "agent-primary/model", fallbacks: ["agent-fallback/model"] },
            },
            entries: {
              worker: { modelPolicy: { allow: ["worker-policy/*"] } },
            },
          },
          hooks: { gmail: { model: "gmail-model/model" } },
          tts: { summaryModel: "untouched-tts/model" },
          channels: {
            modelByChannel: { slack: { room: "channel-model/model" } },
            discord: { voice: { model: "untouched-voice/model" } },
          },
        },
        [
          ["agents", "defaults", "model"],
          ["agents", "entries", "worker", "modelPolicy", "allow", "0"],
          ["hooks", "gmail", "model"],
          ["channels", "modelByChannel", "slack", "room"],
        ],
      ),
    ).toEqual([
      "agent-fallback",
      "agent-primary",
      "channel-model",
      "gmail-model",
      "untouched-tts",
      "untouched-voice",
      "worker-policy",
    ]);
  });

  it("does not infer touched-path ownership from dotted configured ids", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          agents: { entries: { "worker.blue": { model: "provider.with.dots/model" } } },
          plugins: { entries: { other: {} } },
        },
        [["plugins", "entries", "other", "enabled"]],
      ),
    ).toEqual(["other", "provider.with.dots"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
        },
        [["channels"]],
      ),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });
});
