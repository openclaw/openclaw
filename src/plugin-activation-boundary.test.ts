import { expect, it, vi } from "vitest";
import { normalizeModelRef } from "./agents/model-ref-shared.js";
import { isStaticallyChannelConfigured } from "./config/channel-configured-shared.js";

const testModelIdNormalization = {
  providers: {
    google: {
      aliases: {
        "gemini-3.1-pro": "gemini-3.1-pro-preview",
        "gemini-3-pro-preview": "gemini-3.1-pro-preview",
      },
    },
    xai: { aliases: { "grok-4-fast-reasoning": "grok-4-fast" } },
  },
};

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());

const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() => vi.fn());
const channelEnvs = vi.hoisted((): Record<string, NodeJS.ProcessEnv> => ({
  telegram: { TELEGRAM_BOT_TOKEN: "token" },
  discord: { DISCORD_BOT_TOKEN: "token" },
  slack: { SLACK_BOT_TOKEN: "xoxb-test" },
  irc: { IRC_HOST: "irc.example.com", IRC_NICK: "openclaw" },
}));

const facadeMockHelpers = vi.hoisted(() => ({
  createLazyFacadeObjectValue: <T extends object>(load: () => T): T =>
    new Proxy({} as T, {
      get: (_target, property, receiver) => Reflect.get(load(), property, receiver),
    }),
}));

vi.mock("./plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
}));

// mock-isolation: Keep channel environment lookup independent of runtime plugin discovery.
vi.mock("./secrets/channel-env-vars.js", () => ({
  getChannelEnvVars: (channelId: string) => Object.keys(channelEnvs[channelId] ?? {}),
}));

vi.mock("./plugin-sdk/facade-loader.js", () => ({
  ...facadeMockHelpers,
  listImportedBundledPluginFacadeIds: () => [],
  loadBundledPluginPublicSurfaceModuleSyncCore,
  loadFacadeModuleAtLocationSync: vi.fn(),
  resetFacadeLoaderStateForTest: vi.fn(),
}));

vi.mock("./plugin-sdk/facade-runtime.js", () => ({
  ...facadeMockHelpers,
  testing: {},
  listImportedBundledPluginFacadeIds: () => [],
  loadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSyncCore,
  loadBundledPluginPublicSurfaceModuleSyncCore,
  resetFacadeRuntimeStateForTest: vi.fn(),
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync:
    loadBundledPluginPublicSurfaceModuleSyncCore,
}));

it("keeps generic channel and model-normalization boundaries cold", () => {
  loadBundledPluginPublicSurfaceModuleSyncCore.mockReset();

  for (const [channel, env] of Object.entries(channelEnvs)) {
    expect(isStaticallyChannelConfigured({}, channel, env)).toBe(true);
  }
  expect(isStaticallyChannelConfigured({}, "whatsapp", {})).toBe(false);
  const staticNormalize = {
    allowPluginNormalization: false,
    manifestPlugins: [{ modelIdNormalization: testModelIdNormalization }],
  };
  for (const [provider, input, model] of [
    ["google", "gemini-3.1-pro", "gemini-3.1-pro-preview"],
    ["google", "gemini-3-pro-preview", "gemini-3.1-pro-preview"],
    ["xai", "grok-4-fast-reasoning", "grok-4-fast"],
  ] as const) {
    expect(normalizeModelRef(provider, input, staticNormalize)).toEqual({ provider, model });
  }
  expect(loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
  expect(loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
});
