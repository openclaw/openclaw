import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createLegacyWebhookListenerDoctorContract } from "../plugin-sdk/legacy-webhook-listener-migration.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type * as DoctorContractRegistry from "./doctor-contract-registry.js";
import { useDoctorContractRegistryHarness } from "./doctor-contract-registry.test-harness.js";
import { defineRetiredPluginStateMigration } from "./doctor-retired-state.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
// mock-isolation: Script retained artifacts without loading real bundled plugin modules.
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
const harness = useDoctorContractRegistryHarness({
  reset: () => {
    mockDoctorPlugins();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
  },
});
const { mocks, warn: doctorContractWarnMock, makeTempDir } = harness;

let doctor: typeof DoctorContractRegistry;
let migrationResources: typeof import("./doctor-migration-resources.js");
beforeAll(async () => {
  doctor = harness.registry;
  migrationResources = await import("./doctor-migration-resources.js");
});

function registry(...plugins: Parameters<typeof createPluginManifestRecordFixture>[0][]) {
  return {
    plugins: plugins.map(createPluginManifestRecordFixture),
    diagnostics: [],
  };
}

function mockDoctorPlugins(...plugins: Parameters<typeof createPluginManifestRecordFixture>[0][]) {
  mocks.loadPluginManifestRegistry.mockReturnValue(registry(...plugins));
}

function writeContract(source = "export {};\n", name = "doctor-contract-api.ts") {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, name), source, "utf-8");
  return root;
}

function mockContract(
  exports: Record<string, unknown>,
  plugin: Parameters<typeof createPluginManifestRecordFixture>[0],
) {
  const rootDir = writeContract();
  mocks.createJiti.mockImplementation(() => () => exports);
  mockDoctorPlugins({ rootDir, ...plugin });
  return rootDir;
}

const providerRenames = [{ from: "old", to: "new", baseUrl: "https://models.example" }];
const providerConfig = (baseUrl: string) => ({ baseUrl, models: [] });

function mockExternalShadow(enabledByDefault = false) {
  const bundled = registry({
    id: "matrix",
    rootDir: makeTempDir(),
    origin: "bundled",
    doctorContract: { stateMigrations: [{ id: "matrix-inbound-dedupe-to-claimable-dedupe" }] },
  });
  mocks.loadPluginManifestRegistry.mockReturnValueOnce(bundled).mockReturnValueOnce(
    registry({
      id: "matrix",
      rootDir: makeTempDir(),
      origin: "global",
      doctorContract: bundled.plugins[0]?.doctorContract,
      ...(enabledByDefault ? { enabledByDefault } : {}),
    }),
  );
}

describe("doctor-contract-registry module loader", () => {
  it.each([false, undefined, true])("gates config-repair artifacts: %s", (configRepair) => {
    const count = configRepair === false ? 0 : 1;
    const pluginRoot = mockContract(
      {
        legacyConfigRules: [{ path: ["plugins", "entries", "demo"], message: "demo rule" }],
        providerRenames,
      },
      {
        id: "test-plugin",
        providers: ["old", "new"],
        ...(configRepair === undefined ? {} : { doctorContract: { configRepair } }),
      },
    );

    expect(
      doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} }),
    ).toHaveLength(count);
    expect(doctor.resolvePluginDoctorProviderRenames({ pluginIds: ["old"], env: {} })).toHaveLength(
      count,
    );
    expect(mocks.createJiti).toHaveBeenCalledTimes(count);
  });

  it("rejects provider renames outside the plugin's declared providers", () => {
    const root = mockContract(
      { providerRenames },
      { id: "owner", providers: ["old"], doctorContract: { configRepair: true } },
    );
    expect(doctor.resolvePluginDoctorProviderRenames({ pluginIds: ["old"], env: {} })).toEqual([]);
    expect(doctorContractWarnMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `failed to load doctor contract for owner from ${path.join(root, "doctor-contract-api.ts")}: Provider renames must belong to the plugin's declared providers.`,
      ),
    );
  });

  it("defers declared provider renames during compatibility preflight", () => {
    mockContract(
      { providerRenames },
      {
        id: "rename-owner",
        providers: ["old", "new"],
        doctorContract: { configRepair: true },
      },
    );
    const config: OpenClawConfig = {
      models: {
        providers: {
          old: { ...providerConfig("https://models.example"), api: "openai-completions" },
        },
      },
      agents: { defaults: { model: "old/model@old:default" } },
      auth: { profiles: { "old:default": { provider: "old", mode: "api_key" } } },
    };
    const original = structuredClone(config);
    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, {
      env: {},
      pluginIds: ["old"],
    });
    expect([result.config, result.changes]).toEqual([original, []]);
    expect(config).toEqual(original);
  });

  it.each(["repair", "throw", "warning"])("isolates a normalizer-only config %s", (mode) => {
    mockContract(
      {
        normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => {
          cfg.repaired = true;
          if (mode === "throw") {
            throw new Error("fixture repair failed");
          }
          return mode === "warning"
            ? { config: cfg, changes: [], warnings: ["Repair requires operator input."] }
            : { config: cfg, changes: ["repaired config"] };
        },
      },
      { id: "normalizer-only", doctorContract: { configRepair: true } },
    );

    const config = {};
    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} });
    expect(config).toEqual({});
    expect(result.config).toEqual(mode === "repair" ? { repaired: true } : {});
    expect(result.changes).toEqual(mode === "repair" ? ["repaired config"] : []);
    expect(result.warnings).toEqual(
      mode === "throw"
        ? [
            expect.stringContaining(
              'Plugin "normalizer-only" config repair failed: fixture repair failed',
            ),
          ]
        : mode === "warning"
          ? ["Repair requires operator input."]
          : undefined,
    );
  });

  it.each(["js", "ts"])(
    "loads Windows %s contracts through their compatible boundary",
    (extension) => {
      const legacyConfigRules = [
        { path: ["plugins", "entries", "demo", "legacy"], message: "legacy demo key" },
      ];
      const source =
        extension === "js"
          ? `module.exports = ${JSON.stringify({ legacyConfigRules })};\n`
          : `export const legacyConfigRules = ${JSON.stringify(legacyConfigRules)};\n`;
      const pluginRoot = writeContract(source, `contract-api.${extension}`);
      mocks.createJiti.mockImplementation(() => () => ({ legacyConfigRules }));
      mockDoctorPlugins({ id: "test-plugin", rootDir: pluginRoot });
      withMockedPlatform("win32", () => {
        expect(
          doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} }),
        ).toEqual(legacyConfigRules);
      });
      expect(mocks.createJiti).toHaveBeenCalledTimes(extension === "ts" ? 1 : 0);
      if (extension === "ts") {
        expect(mocks.createJiti).toHaveBeenCalledWith(
          pathToFileURL(path.join(pluginRoot, "contract-api.ts"), { windows: true }).href,
          expect.objectContaining({ tryNative: false }),
        );
      }
    },
  );

  it("loads config-derived session-store agent IDs from doctor contract modules", () => {
    const pluginRoot = writeContract(
      "module.exports = { resolveSessionStoreAgentIds: ({ cfg }) => [cfg.plugins.entries.demo.config.agentId, 'voice', ' '] };\n",
      "doctor-contract-api.cjs",
    );
    mockDoctorPlugins({ id: "test-plugin", packageName: "@openclaw/demo", rootDir: pluginRoot });

    expect(
      doctor.listPluginDoctorSessionStoreAgentIds({
        config: { plugins: { entries: { demo: { config: { agentId: "cards" } } } } },
        workspaceDir: pluginRoot,
        env: {},
        pluginIds: ["@openclaw/demo"],
      }),
    ).toEqual(["cards", "voice"]);
  });

  it("deduplicates manifest owners by first id and sorts them by id", () => {
    mockDoctorPlugins(
      ...(
        [
          ["google", "google", "Google"],
          ["anthropic", "anthropic", "Anthropic"],
          ["google-shadow", "google", "Ignored duplicate"],
        ] as const
      ).map(([id, ownerId, label]) => ({
        id,
        rootDir: `/plugins/${id}`,
        sessionRouteStateOwners: [{ id: ownerId, label }],
      })),
    );

    expect(
      doctor.listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["anthropic", "google", "google-shadow"],
      }),
    ).toEqual([
      { id: "anthropic", label: "Anthropic" },
      { id: "google", label: "Google" },
    ]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("reads doctor contracts from the current manifest registry on each call", () => {
    for (const id of ["first", "second"]) {
      const rootDir = writeContract(
        `module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', '${id}'], message: '${id} contract' }] };\n`,
        "doctor-contract-api.cjs",
      );
      mocks.loadPluginManifestRegistry.mockReturnValueOnce(
        registry({ id: `${id}-plugin`, rootDir }),
      );
    }
    for (const id of ["first", "second"]) {
      expect(
        doctor.listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} }),
      ).toEqual([{ path: ["plugins", "entries", id], message: `${id} contract` }]);
    }
  });

  it.each([true, false, undefined])(
    "does not grant bundled migration descriptors to a selected external shadow (enabled: %s)",
    (enabled) => {
      mockExternalShadow(enabled === undefined);
      const config = enabled === undefined ? {} : { plugins: { entries: { matrix: { enabled } } } };

      expect(doctor.resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
        knownPluginIds: [],
        sessionStoreOwnerPluginIds: [],
        descriptors: [],
        unresolvedPluginIds: ["matrix"],
      });
    },
  );

  it("keeps a disabled bundled channel catalog-known without making it executable or unresolved", () => {
    const bundled = registry({
      id: "discord",
      rootDir: makeTempDir(),
      channels: ["discord"],
      doctorContract: { stateMigrations: [{ id: "discord-legacy-channel-state" }] },
    });
    mocks.loadPluginManifestRegistry.mockReturnValueOnce(bundled).mockReturnValueOnce(bundled);
    const config = {
      channels: { discord: { enabled: false } },
      plugins: { entries: { discord: { enabled: false } } },
    };

    expect(doctor.resolvePluginDoctorStateMigrationInventory({ config, env: {} })).toEqual({
      knownPluginIds: ["discord"],
      sessionStoreOwnerPluginIds: [],
      descriptors: [],
      unresolvedPluginIds: [],
    });
  });
});

function mockRawDoctorPlugins(...plugins: Record<string, unknown>[]): void {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

describe("doctor-contract-registry selection", () => {
  const configuredProviders = [
    "channel",
    "default",
    "entry",
    "fallback",
    "gmail",
    "hook",
    "opencode",
    "policy",
    "tts",
    "voice",
    "worker",
  ];
  it.each([
    { name: "missing official plugin", pins: true },
    { name: "unresolved host facts", warning: "Resolve account ambiguity", pins: false },
    { name: "deferred installed owner", ownerId: "feishu", pins: false },
    { name: "deferred trusted official owner", ownerId: "feishu", trusted: true, pins: true },
    {
      name: "deferred trusted owner with authored endpoints",
      ownerId: "feishu",
      trusted: true,
      explicit: true,
      pins: true,
    },
    {
      name: "deferred trusted owner excluded by the allowlist",
      ownerId: "feishu",
      trusted: true,
      restricted: true,
      pins: false,
    },
    {
      name: "deferred replacement owner",
      ownerId: "custom-feishu",
      pins: false,
    },
  ])("preserves historical webhook ownership for $name", (scenario) => {
    const { ownerId, trusted, restricted, warning, explicit = false, pins } = scenario;
    const config: OpenClawConfig = {
      meta: { migrations: { webhookListeners: { telegram: [] } } },
      ...(restricted ? { plugins: { allow: ["other-plugin"] } } : {}),
      channels: {
        feishu: {
          enabled: true,
          connectionMode: "webhook",
          ...(explicit ? { webhookPort: 9001, webhookHost: "0.0.0.0" } : {}),
          accounts: { default: { enabled: true } },
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
      normalizeCompatibilityConfig: () => {
        throw new Error("deferred repair ran");
      },
      normalizeHistoricalWebhookConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
        ...listener.normalizeCompatibilityConfig({ cfg }),
        historicalWebhookAccountIds: ["default"],
        ...(warning ? { warnings: [warning] } : {}),
      }),
    });
    if (ownerId) {
      const pluginRoot = writeContract();
      mocks.createJiti.mockImplementation(() => () => ({
        normalizeCompatibilityConfig: () => {
          throw new Error("deferred owner ran");
        },
      }));
      mockRawDoctorPlugins({
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
    const result = doctor.withDeferredPluginDoctorMigrations([ownerId ?? "feishu"], () =>
      doctor.applyPluginDoctorCompatibilityMigrations(config, {
        config,
        env: {},
        pluginIds: ["feishu"],
        historicalWebhookListeners: true,
        onInspectedPlugin: inspected,
      }),
    );

    expect(config).toEqual(original);
    const expected = structuredClone(original);
    if (pins || restricted) {
      expected.meta = {
        migrations: {
          webhookListeners: {
            telegram: [],
            feishu:
              pins && !explicit
                ? [["channels", "feishu", "accounts", "default", "legacyWebhook"]]
                : [],
          },
        },
      };
    }
    if (pins) {
      const channel = expected.channels!.feishu;
      if (explicit) {
        delete channel.webhookPort;
        delete channel.webhookHost;
        channel.legacyWebhook = { port: 9001, host: "0.0.0.0" };
      } else {
        channel.accounts.default.legacyWebhook = { port: 3000, host: "127.0.0.1" };
      }
    }
    expect(result.config).toEqual(expected);
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
    ["full scan", undefined, true, true],
    ["parent edit", [["legacyRoots"]], true, true],
    ["dotted owner edit", [["legacyRoots", "store.with.dots", "root"]], true, true],
    ["unrelated edit", [["gateway", "port"]], true, false],
    ["empty edit", [], true, false],
    ["undeclared repair", undefined, false, false],
  ] satisfies Array<[string, string[][] | undefined, boolean, boolean]>)(
    "discovers declared config migration sources without plugin entries: %s",
    async (_name, touchedPaths, configRepair, expected) => {
      const pluginRoot = writeContract();
      const rule = {
        path: ["legacyRoots", "store.with.dots", "root"],
        message: "Migrate legacy root",
      };
      mocks.createJiti.mockImplementation(() => () => ({
        legacyConfigRules: [rule],
        resolveSessionStoreAgentIds: () => ["unexpected-owner"],
      }));
      mockRawDoctorPlugins({
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
      const pluginIds = doctor.collectRelevantDoctorPluginIds(raw);
      expect(pluginIds).toEqual([]);
      expect(doctor.listPluginDoctorSessionStoreAgentIds({ pluginIds })).toEqual([]);
    },
  );

  it.each([
    {
      name: "configured-model and policy providers without shadow-list owners",
      raw: {
        models: { providers: { "ollama-cloud": {} } },
        agents: {
          defaults: {
            model: { primary: "default/model", fallbacks: ["fallback/model", 42] },
            modelPolicy: { allow: ["default/*", "policy/*", 42, "bare"] },
          },
          entries: {
            worker: { model: "entry/model", modelPolicy: { allow: ["worker/model", null] } },
          },
          list: [
            {
              id: "shadow",
              model: "shadow/model",
              modelPolicy: { allow: ["shadow-policy/model"] },
            },
          ],
        },
        hooks: {
          mappings: [{ model: "hook/model" }, { model: 42 }],
          gmail: { model: "gmail/model" },
        },
        tts: { summaryModel: "tts/model" },
        tools: { media: { image: { preferredModel: "opencode/minimax-m3" } } },
        channels: {
          modelByChannel: { slack: { room: "channel/model" } },
          discord: { voice: { model: "voice/model" } },
        },
      },
      ids: [...configuredProviders, "discord", "ollama-cloud"].toSorted(),
      touchedIds: configuredProviders,
    },
    {
      name: "model and policy providers from the legacy list when entries is absent",
      raw: {
        agents: {
          list: [
            {
              id: "legacy",
              model: "legacy-model/model",
              modelPolicy: { allow: ["legacy-policy/*"] },
            },
          ],
        },
      },
      ids: ["legacy-model", "legacy-policy"],
      touchedIds: ["legacy-model", "legacy-policy"],
    },
    {
      name: "no shadow-list policy providers when entries is null",
      raw: {
        agents: {
          entries: null,
          list: [{ id: "shadow", modelPolicy: { allow: ["shadow-policy/*"] } }],
        },
      },
      ids: [],
      touchedIds: [],
    },
  ])("collects $name", ({ raw, ids, touchedIds }) => {
    expect(doctor.collectRelevantDoctorPluginIds(raw)).toEqual(ids);
    expect(
      doctor.collectDoctorConfigRepairPluginIds(raw, [["agents", "defaults", "model"]]),
    ).toEqual(touchedIds);
  });

  it("narrows touched doctor scans without treating channel metadata as owners", () => {
    const raw = {
      plugins: { entries: { "memory-wiki": {} } },
      channels: {
        defaults: {},
        modelByChannel: { discord: { guild: "openai/gpt-5.6-luna" } },
        " ": {},
        discord: {},
        telegram: {},
      },
      models: { providers: { "ollama-cloud": {} } },
      talk: { voiceId: "legacy-voice" },
    };

    const allIds = ["discord", "elevenlabs", "memory-wiki", "ollama-cloud", "openai", "telegram"];
    expect(doctor.collectRelevantDoctorPluginIds(raw)).toEqual(allIds);
    expect(
      doctor.collectDoctorConfigRepairPluginIds(raw, [
        ["channels", "modelByChannel", "discord", "guild"],
      ]),
    ).toStrictEqual(["openai"]);
    expect(doctor.collectDoctorConfigRepairPluginIds(raw, [["channels"]])).toEqual(allIds);
    expect(
      doctor.collectDoctorConfigRepairPluginIds(raw, [
        ["channels", "discord", "token"],
        ["plugins", "entries", "memory-wiki", "enabled"],
        ["models", "providers", "ollama-cloud", "baseUrl"],
        ["talk", "voiceId"],
      ]),
    ).toEqual(["discord", "elevenlabs", "memory-wiki", "ollama-cloud", "openai"]);
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

    const expected = ["gemini", "openai", "xai"];
    expect(doctor.collectRelevantDoctorPluginIds(raw)).toEqual(expected);
    expect(
      doctor.collectDoctorConfigRepairPluginIds(raw, [["tools", "media", "models", "2", "model"]]),
    ).toEqual(expected);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider alias", () => {
    const pluginRoot = writeContract();
    const unrelatedRoot = writeContract();
    const config = {
      models: { providers: { "ollama-cloud": providerConfig("https://ai.ollama.com") } },
    };
    mocks.createJiti.mockImplementation(() => (modulePath: string) => ({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: typeof config }) => {
        cfg.models.providers["ollama-cloud"].baseUrl = "https://ollama.com";
        return {
          config: cfg,
          changes: [
            modulePath.startsWith(unrelatedRoot)
              ? "wrong unrelated provider contract"
              : "normalized ollama cloud provider endpoint",
          ],
        };
      },
    }));
    mockRawDoctorPlugins(
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

    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds: ["ollama-cloud"],
    });

    expect(result.changes).toEqual(["normalized ollama cloud provider endpoint"]);
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual(
      providerConfig("https://ollama.com"),
    );
  });

  it("selects a mixed-case manifest Doctor owner from its canonical config entry", () => {
    mockContract(
      {
        normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
          config: { ...cfg, repairedBy: "MiXeD-upgrade-proof" },
          changes: ["mixed-case owner repaired config"],
        }),
      },
      { id: "MiXeD-upgrade-proof", doctorContract: { configRepair: true } },
    );
    const config = { plugins: { entries: { "mixed-upgrade-proof": { enabled: true } } } };
    const result = doctor.applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds: doctor.collectRelevantDoctorPluginIds(config),
    });
    expect(result.changes).toEqual(["mixed-case owner repaired config"]);
    expect(result.config).toHaveProperty("repairedBy", "MiXeD-upgrade-proof");
  });
});

const channelConfig = () => ({
  channels: { discord: { dm: { enabled: true, policy: "allowlist" } } },
});

it("repairs retained channel config before installation without selecting state owners", () => {
  const rule = { path: ["channels", "discord", "dm", "policy"], message: "retired DM policy" };
  const config = { ...channelConfig(), plugins: { allow: [] } };
  retainedConfigDoctorMock.mockReturnValue({
    legacyConfigRules: [rule],
    normalizeCompatibilityConfig: ({ cfg }: { cfg: typeof config }) => ({
      config: { ...cfg, channels: { discord: { dmPolicy: cfg.channels.discord.dm.policy } } },
      changes: ["moved DM policy"],
    }),
    resolveSessionStoreAgentIds: () => {
      throw new Error("must not select retained state owners");
    },
  });

  expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([rule]);
  expect(doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} })).toEqual({
    config: { channels: { discord: { dmPolicy: "allowlist" } }, plugins: { allow: [] } },
    changes: ["moved DM policy"],
  });
  expect(config.channels.discord.dm.policy).toBe("allowlist");
  expect(retainedConfigDoctorMock).toHaveBeenCalledWith({
    dirName: "discord",
    artifactCandidates: ["config-doctor-api.js"],
    env: {},
  });
  retainedConfigDoctorMock.mockClear();
  expect([
    doctor.listPluginDoctorSessionStoreAgentIds({ config, env: {} }),
    doctor.listPluginDoctorSessionRouteStateOwners({ config, env: {} }),
  ]).toEqual([[], []]);
  expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
});

it.each([false, true])("keeps installed owner (configRepair=%s)", (configRepair) => {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      {
        id: "installed-owner",
        channels: ["discord"],
        providers: [],
        rootDir: makeTempDir(),
        doctorContract: { configRepair },
      },
    ],
    diagnostics: [],
  });
  const config = channelConfig();
  expect(doctor.listPluginDoctorLegacyConfigRules({ config, env: {} })).toEqual([]);
  const result = doctor.applyPluginDoctorCompatibilityMigrations(config, { env: {} });
  expect(result).toEqual({ config, changes: [] });
  expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
});

it("does not probe retained modules outside the selected known channel scope", () => {
  const scopes = [
    { config: { channels: { discord: {}, "../outside": {}, defaults: {} } }, pluginIds: ["slack"] },
    { config: { channels: { "../outside": {} } } },
  ];
  expect(
    scopes.map((scope) => doctor.listPluginDoctorLegacyConfigRules({ ...scope, env: {} })),
  ).toEqual([[], []]);
  expect(retainedConfigDoctorMock).not.toHaveBeenCalled();
});
it.each([
  { name: "selected official owner", refuses: true },
  { name: "external shadow", trusted: false },
  { name: "different package", packageName: "@other/demo" },
  { name: "different migration", declared: false },
  { name: "disabled owner", enabled: false },
])(
  "checks only the matching $name",
  async ({
    trusted = true,
    declared = true,
    enabled = true,
    packageName = "@openclaw/demo",
    refuses = false,
  }) => {
    const stateDir = makeTempDir();
    const source = path.join(stateDir, "custom-history.jsonl");
    fs.writeFileSync(source, "opaque historical bytes\n");
    const migration = defineRetiredPluginStateMigration({
      id: "retired-log",
      label: "Call log",
      intermediateVersion: "2026.9.7",
      findSources: () => [source],
    });
    retainedConfigDoctorMock.mockReturnValue({
      packageName: "@openclaw/demo",
      stateMigrations: [migration],
    });
    const owner = createPluginManifestRecordFixture({
      id: "demo",
      origin: "global",
      rootDir: stateDir,
      packageName,
      trustedOfficialInstall: trusted,
      doctorContract: { stateMigrations: [{ id: declared ? "retired-log" : "other" }] },
    });
    const params = {
      candidateRoot: stateDir,
      config: { plugins: { entries: { demo: { enabled } } } },
      env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      stateDir,
      manifestRegistry: { plugins: [owner], diagnostics: [] },
    };
    const records = doctor
      .resolvePluginDoctorStateMigrationRecords({ ...params, artifactPreservingReadOnly: true })
      .filter(doctor.isTrustedForDurableStores);
    const check = migrationResources.assertPluginStateRetention(records, params);
    if (refuses) {
      await expect(check).rejects.toThrow("Install OpenClaw 2026.9.7");
    } else {
      await expect(check).resolves.toBeUndefined();
    }
    expect(fs.readFileSync(source, "utf8")).toBe("opaque historical bytes\n");
    expect(fs.readdirSync(stateDir)).toEqual(["custom-history.jsonl"]);
  },
);
