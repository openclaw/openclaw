// Covers plugin doctor selection from config and touched paths.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createLegacyWebhookListenerDoctorContract } from "../plugin-sdk/legacy-webhook-listener-migration.js";
import { useDoctorContractRegistryHarness } from "./doctor-contract-registry.test-harness.js";

const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
const harness = useDoctorContractRegistryHarness({
  reset: () => {
    mockDoctorPlugins();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
  },
});
const { mocks, makeTempDir } = harness;

function mockDoctorPlugins(...plugins: Record<string, unknown>[]): void {
  mocks.loadPluginManifestRegistry.mockReturnValue({ plugins, diagnostics: [] });
}

describe("doctor-contract-registry selection", () => {
  it.each([
    { name: "missing official plugin", pins: true },
    { name: "authored listener endpoints", explicit: true, pins: true },
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
    const result = harness.registry.withDeferredPluginDoctorMigrations([ownerId ?? "feishu"], () =>
      harness.registry.applyPluginDoctorCompatibilityMigrations(config, {
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
        channel.accounts.specific = {
          enabled: true,
          legacyWebhook: { port: 9002, host: "0.0.0.0" },
        };
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
      const pluginIds = harness.registry.collectRelevantDoctorPluginIds(raw);
      expect(pluginIds).toEqual([]);
      expect(harness.registry.listPluginDoctorSessionStoreAgentIds({ pluginIds })).toEqual([]);
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
        hooks: { mappings: [{ model: "hook/model" }, { model: 42 }] },
      },
      ids: ["default", "entry", "fallback", "hook", "ollama-cloud", "policy", "worker"],
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
    },
  ])("collects $name", ({ raw, ids }) => {
    expect(harness.registry.collectRelevantDoctorPluginIds(raw)).toEqual(ids);
  });

  it("excludes channel metadata and blank ids from full and touched doctor scans", () => {
    const raw = {
      plugins: { entries: { "memory-wiki": {} } },
      channels: {
        defaults: {},
        modelByChannel: { discord: { guild: "openai/gpt-5.6-luna" } },
        " ": {},
        discord: {},
      },
    };

    expect(harness.registry.collectRelevantDoctorPluginIds(raw)).toEqual([
      "discord",
      "memory-wiki",
      "openai",
    ]);
    expect(
      harness.registry.collectDoctorConfigRepairPluginIds(raw, [
        ["channels", "modelByChannel", "discord", "guild"],
      ]),
    ).toStrictEqual(["openai"]);
    expect(harness.registry.collectDoctorConfigRepairPluginIds(raw, [["channels"]])).toEqual([
      "discord",
      "memory-wiki",
      "openai",
    ]);
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

    expect(harness.registry.collectRelevantDoctorPluginIds(raw)).toEqual([
      "gemini",
      "openai",
      "xai",
    ]);
    expect(
      harness.registry.collectDoctorConfigRepairPluginIds(raw, [
        ["tools", "media", "models", "2", "model"],
      ]),
    ).toEqual(["gemini", "openai", "xai"]);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider alias", () => {
    const pluginRoot = makeTempDir();
    const unrelatedRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    fs.writeFileSync(path.join(unrelatedRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    const config = {
      models: { providers: { "ollama-cloud": { baseUrl: "https://ai.ollama.com", models: [] } } },
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

    const result = harness.registry.applyPluginDoctorCompatibilityMigrations(config, {
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

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      harness.registry.collectDoctorConfigRepairPluginIds(
        {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: { "memory-wiki": {} },
          },
          models: {
            providers: { "ollama-cloud": {} },
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
      harness.registry.collectDoctorConfigRepairPluginIds(
        {
          agents: {
            defaults: {
              model: { primary: "primary/model", fallbacks: ["fallback/model"] },
            },
            entries: {
              worker: { modelPolicy: { allow: ["worker/*"] } },
            },
          },
          hooks: { gmail: { model: "gmail/model" } },
          tts: { summaryModel: "tts/model" },
          tools: { media: { image: { preferredModel: "opencode/minimax-m3" } } },
          channels: {
            modelByChannel: { slack: { room: "channel/model" } },
            discord: { voice: { model: "voice/model" } },
          },
        },
        [
          ["agents", "defaults", "model"],
          ["agents", "entries", "worker", "modelPolicy", "allow", "0"],
          ["hooks", "gmail", "model"],
          ["channels", "modelByChannel", "slack", "room"],
        ],
      ),
    ).toEqual(["channel", "fallback", "gmail", "opencode", "primary", "tts", "voice", "worker"]);
  });
});
