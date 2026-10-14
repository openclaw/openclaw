import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  registryContainsRuntimePluginIds,
  resolveCompatibleRuntimePluginRegistry,
} from "./active-runtime-registry.js";
import type {
  PluginCapabilityCatalogContext,
  PluginCapabilityCatalogHostContext,
} from "./capability-catalog-context.types.js";
import { isPluginRegistryLoadInFlight, resolvePluginRegistryLoadCacheKey } from "./loader-cache.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { loadOpenClawPluginsWithInternalOverrides } from "./loader-runtime-load.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import * as nativeModuleRequire from "./native-module-require.js";
import {
  createPluginCache,
  getPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { disposePluginRegistryInstances, setActivePluginRegistry } from "./runtime.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

const families = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;
const contextSymbol = Symbol.for("fixture.capability-context");

function createContext(): PluginCapabilityCatalogHostContext {
  const unavailable = () => {
    throw new Error("registration invoked a host operation");
  };
  return {
    isProviderApiKeyConfigured: unavailable,
    isProviderApiKeyConfiguredAsync: unavailable,
    isProviderAuthProfileConfigured: unavailable,
    isProviderAuthProfileConfiguredAsync: unavailable,
    resolveAgentDir: unavailable,
    createRealtimeTranscriptionWebSocketSession: unavailable,
    resolveProviderRequestHeaders: unavailable,
    resolveProviderAuthProfileApiKey: unavailable,
    resolveApiKeyForProvider: unavailable,
    captureWsEvent: unavailable,
    captureWsEventAsync: unavailable,
    createDebugProxyWebSocketAgent: unavailable,
    resolveDebugProxySettings: unavailable,
    fetchWithSsrFGuard: unavailable,
    createProviderHttpError: unavailable,
    readProviderJsonResponse: unavailable,
    readProviderTextResponse: unavailable,
    formatErrorMessage: vi.fn(() => "ready"),
    warn: unavailable,
    redactSensitiveText: unavailable,
  };
}

async function withFactoryPlugin(
  register: string,
  run: (options: PluginLoadOptions, root: string) => Promise<void> | void,
  manifest?: Record<string, unknown>,
) {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const plugin = writePlugin({
    id: "factory-owner",
    dir: path.join(root, "plugin"),
    filename: "index.cjs",
    body: `module.exports = {
      id: "factory-owner",
      register(api) {
        ${register}
      }
    };`,
  });
  if (manifest) {
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", additionalProperties: false },
        ...manifest,
      }),
    );
  }
  await withEnvAsync(
    {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    },
    async () =>
      await run(
        {
          config: {
            plugins: {
              allow: [plugin.id],
              load: { paths: [plugin.file] },
              slots: { memory: "none" },
            },
          },
          pluginSdkResolution: "src",
          activate: false,
        },
        root,
      ),
  );
}

const registerFactories = `
  const providerId = api.runtime.modelAuth.resolveProviderIdForAuth(" Fixture ", { metadataSnapshot: { plugins: [] } });
  const model = api.runtime.modelConfig.resolveAllowedModelRef({
    cfg: api.config, catalog: [], raw: "fixture/allowed", defaultProvider: "fixture", manifestPlugins: [],
  });
  if (providerId !== "fixture" || model?.key !== "fixture/allowed") {
    throw new Error("native model policy bindings are unavailable");
  }
  const createProvider = (host) => {
    const provider = {
      id: "factory-provider", label: "Factory provider",
      isConfigured: () => host.formatErrorMessage(new Error("ready")) === "ready",
      synthesize: async () => { throw new Error("not synthesis"); },
      createSession: () => { throw new Error("not a session"); },
      createBridge: () => { throw new Error("not a bridge"); }
    };
    Object.defineProperty(provider, Symbol.for("fixture.capability-context"), { value: host });
    return provider;
  };
  api.registerSpeechProvider(createProvider);
  api.registerRealtimeTranscriptionProvider(createProvider);
  api.registerRealtimeVoiceProvider(createProvider);
  api.registerService({ id: "factory-lifecycle", start() {} });
`;

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("retains the creating cache generation when broad services initialize later", () => {
  const owner = createPluginCache();
  const replacement = createPluginCache();
  const runtime = { events: {} } as PluginRuntime;
  const createPluginRuntime = vi.fn(() => {
    expect(getPluginCache()).toBe(owner);
    return runtime;
  });
  const loadRuntimeModule = vi
    .spyOn(nativeModuleRequire, "tryNativeRequireModule")
    .mockImplementation(() => {
      expect(getPluginCache()).toBe(owner);
      return { ok: true, moduleExport: { createPluginRuntime } };
    });
  const lazyRuntime = withPluginCache(owner, () => createLazyPluginRuntime({}));
  expect(loadRuntimeModule).not.toHaveBeenCalled();
  withPluginCache(replacement, () => {
    expect(lazyRuntime.events).toBe(runtime.events);
    expect(lazyRuntime.events).toBe(runtime.events);
  });
  expect(loadRuntimeModule).toHaveBeenCalledTimes(1);
  expect(createPluginRuntime).toHaveBeenCalledTimes(1);
});

describe("capability factory registration", () => {
  it("composes native capability factories with a restricted runtime", async () => {
    await withFactoryPlugin(registerFactories, (options) => {
      const resolveRuntime = vi
        .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
        .mockImplementation(() => {
          throw new Error("restricted registration must not load the broad runtime");
        });
      const registry = loadOpenClawPluginsWithInternalOverrides(
        { ...options, cache: false },
        {
          runtime: {
            config: {
              current: () => options.config ?? {},
              mutateConfigFile: async () => {
                throw new Error("restricted registration cannot mutate config");
              },
              replaceConfigFile: async () => {
                throw new Error("restricted registration cannot replace config");
              },
            },
          },
          moduleLoader: { installNativeSdkResolver: false, loaderFilename: import.meta.url },
        },
      );
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: "factory-owner", status: "loaded" }),
      );
      expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(true);
      expect(registry.services.map((entry) => entry.service.id)).toEqual(["factory-lifecycle"]);
      for (const family of families) {
        expect(registry[family]).toHaveLength(1);
      }
      const runtime = getPluginRegistryRuntime(registry)!;
      for (const facet of ["modelAuth", "modelConfig"] as const) {
        expect(Object.getOwnPropertyDescriptor(runtime, facet)).toEqual({
          configurable: true,
          enumerable: true,
          get: expect.any(Function),
          set: undefined,
        });
      }
      expect(
        registry.speechProviders[0]!.provider.isConfigured({
          cfg: {},
          providerConfig: {},
          timeoutMs: 1000,
        }),
      ).toBe(true);
      expect(resolveRuntime).not.toHaveBeenCalled();
    });
  });

  it("agrees on raw authored options during load, cache reuse, and active lookup", async () => {
    await withFactoryPlugin(
      'api.logger.info("inside registration");' + registerFactories,
      (options, root) => {
        let inFlightAtRegistration: boolean | undefined;
        let registrations = 0;
        const authored: PluginLoadOptions = Object.freeze({
          ...options,
          activate: true,
          runtimeOptions: Object.freeze({}),
          logger: {
            info: (message) => {
              if (message.includes("inside registration")) {
                registrations += 1;
                inFlightAtRegistration = isPluginRegistryLoadInFlight(authored);
              }
            },
            warn() {},
            error() {},
            debug() {},
          },
        });
        const cacheKey = resolvePluginRegistryLoadCacheKey(authored);
        const registry = loadOpenClawPlugins(authored);
        expect(inFlightAtRegistration).toBe(true);
        expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(true);
        expect(isPluginRegistryLoadInFlight(authored)).toBe(false);
        expect(resolvePluginRegistryLoadCacheKey(authored)).toBe(cacheKey);
        expect(getPluginLoaderCacheState().get(cacheKey)).toBe(registry);
        expect(resolveCompatibleRuntimePluginRegistry(authored)).toBe(registry);
        const bound = getPluginRuntimeLoadContext(registry)!;
        const prepared = { ...authored, manifestRegistry: bound.manifestRegistry };
        expect(resolveCompatibleRuntimePluginRegistry(prepared)).toBe(registry);
        expect(loadOpenClawPlugins(prepared) === registry).toBe(true);
        expect(resolveCompatibleRuntimePluginRegistry(authored) === registry).toBe(true);
        expect(resolveCompatibleRuntimePluginRegistry(prepared) === registry).toBe(true);
        expect(registrations).toBe(1);
        expect(loadOpenClawPlugins(authored)).toBe(registry);
        expect(resolveCompatibleRuntimePluginRegistry(prepared)).toBe(registry);
        const changedManifest = {
          ...bound.manifestRegistry!,
          plugins: bound.manifestRegistry!.plugins.map((plugin) =>
            Object.assign({}, plugin, { source: path.join(root, "different-source.cjs") }),
          ),
        };
        const changedSelection = { ...prepared, manifestRegistry: changedManifest };
        expect(resolveCompatibleRuntimePluginRegistry(changedSelection)).toBeUndefined();
        setPluginRuntimeLoadContext(registry, { ...bound, manifestRegistry: changedManifest });
        expect(resolveCompatibleRuntimePluginRegistry(changedSelection)).toBeUndefined();
        expect(resolveCompatibleRuntimePluginRegistry(prepared)).toBe(registry);
        try {
          setActivePluginRegistry(registry, `${cacheKey}-different`);
          expect(resolveCompatibleRuntimePluginRegistry(prepared)).toBeUndefined();
        } finally {
          setActivePluginRegistry(registry, cacheKey);
          setPluginRuntimeLoadContext(registry, bound);
        }
        expect(authored).not.toHaveProperty("capabilityCatalogContext");
        expect(authored.runtimeOptions).toEqual({});
      },
    );
  }, 120_000);

  it("cold-loads a synchronous external-auth and capability-factory hybrid", async () => {
    const register = `
      let host;
      api.registerSpeechProvider((context) => {
        host = context;
        return {
          id: "factory-provider", label: "Factory provider",
          isConfigured: () => true,
          synthesize: async () => { throw new Error("not synthesis"); },
        };
      });
      api.registerProvider({
        id: "factory-provider", label: "Factory provider", auth: [],
        resolveExternalAuthProfiles() {
          if (!host) throw new Error("capability factory context was not bound");
          return [{
            profileId: "factory-provider:external", persistence: "runtime-only",
            credential: { type: "oauth", provider: "factory-provider",
              access: host.formatErrorMessage(new Error("hybrid-ready")),
              refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 },
          }];
        },
      });
    `;
    await withFactoryPlugin(
      register,
      (options, root) => {
        const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
        resolveRuntime.mockImplementation(() => {
          throw new Error("cold external auth must use native factory composition");
        });
        const agentDir = path.join(root, "state", "agents", "main", "agent");
        const store = loadAuthProfileStoreForRuntime(agentDir, {
          config: options.config,
          readOnly: true,
          syncExternalCli: false,
          externalCli: { mode: "none", config: options.config },
        });
        expect(store.profiles["factory-provider:external"]).toMatchObject({
          type: "oauth",
          provider: "factory-provider",
          access: "hybrid-ready",
        });
        expect(store.runtimeExternalProfileIds).toContain("factory-provider:external");
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({});
        expect(resolveRuntime).not.toHaveBeenCalled();
      },
      {
        providers: ["factory-provider"],
        contracts: { externalAuthProviders: ["factory-provider"] },
      },
    );
  }, 120_000);

  it("partitions registry reuse by native context identity", async () => {
    await withFactoryPlugin(registerFactories, async (options) => {
      const firstContext = createContext();
      const firstOptions = { ...options, capabilityCatalogContext: firstContext };
      const first = loadOpenClawPlugins(firstOptions);
      expect(first.speechProviders).toHaveLength(1);
      expect(loadOpenClawPlugins(firstOptions)).toBe(first);
      const secondContext = createContext();
      const second = loadOpenClawPlugins({ ...options, capabilityCatalogContext: secondContext });
      expect(second).not.toBe(first);
      const firstHost = Reflect.get(
        first.speechProviders[0]!.provider,
        contextSymbol,
      ) as PluginCapabilityCatalogContext;
      const secondHost = Reflect.get(
        second.speechProviders[0]!.provider,
        contextSymbol,
      ) as PluginCapabilityCatalogContext;
      firstHost.formatErrorMessage(new Error("first"));
      expect(firstContext.formatErrorMessage).toHaveBeenCalledOnce();
      expect(secondContext.formatErrorMessage).not.toHaveBeenCalled();
      secondHost.formatErrorMessage(new Error("second"));
      expect(secondContext.formatErrorMessage).toHaveBeenCalledOnce();
      const firstRuntime = getPluginRegistryRuntime(first)!;
      const secondRuntime = getPluginRegistryRuntime(second)!;
      firstRuntime.modelAuth.resolveProviderIdForAuth = () => "first-only";
      expect(firstRuntime.modelAuth.resolveProviderIdForAuth("fixture")).toBe("first-only");
      expect(
        secondRuntime.modelAuth.resolveProviderIdForAuth(" Fixture ", {
          metadataSnapshot: { plugins: [] },
        }),
      ).toBe("fixture");
      await disposePluginRegistryInstances(first);
      expect(() => firstHost.formatErrorMessage(new Error("retired"))).toThrow(/reloaded|disabled/);
      expect(firstContext.formatErrorMessage).toHaveBeenCalledOnce();
      expect(secondHost.formatErrorMessage(new Error("still live"))).toBe("ready");
      expect(secondContext.formatErrorMessage).toHaveBeenCalledTimes(2);
    });
  });

  it("rolls back a rejected factory without an unhandled rejection", async () => {
    await withFactoryPlugin(
      `api.registerSpeechProvider({
        id: "before-failure", label: "Before failure", isConfigured: () => true,
        synthesize: async () => { throw new Error("not synthesis"); }
      });
      api.registerRealtimeVoiceProvider(() => Promise.reject(new Error("factory rejected")));`,
      async (options) => {
        const registry = loadOpenClawPlugins({
          ...options,
          capabilityCatalogContext: createContext(),
        });
        expect(registry.plugins).toContainEqual(
          expect.objectContaining({
            id: "factory-owner",
            status: "error",
            error: expect.stringContaining("must be synchronous"),
          }),
        );
        for (const family of families) {
          expect(registry[family]).toEqual([]);
        }
        expect(registry.modelCatalogProviders).toEqual([]);
        expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(false);
        // Assimilated rejected promises/thenables must settle inside the host rejection handler.
        await Promise.resolve();
        await Promise.resolve();
      },
    );
  });
});

it.each([false, true])(
  "owns failed catalog initialization without revoking an earlier success (prior success: %s)",
  async (priorSuccess) => {
    await withFactoryPlugin(
      'throw new Error("catalog inspection must not load full runtime");',
      async (options, root) => {
        fs.writeFileSync(
          path.join(root, "plugin", "catalog.cjs"),
          `const { createPluginRuntimeStore } = require("openclaw/plugin-sdk/runtime-store");
          const store = createPluginRuntimeStore("catalog scope missing");
          let attempts = 0;
          module.exports = () => {
            if (++attempts === ${priorSuccess ? 2 : 1}) throw new Error("catalog construction failed");
            store.setRuntime("Catalog owner");
            return { get speechProviders() { return [{
              id: "factory-owner", label: store.getRuntime(),
              isConfigured: () => store.getRuntime() === "Catalog owner",
              synthesize: async () => { throw new Error("inspection cannot synthesize"); },
              streamSynthesize: async () => ({
                outputFormat: "pcm", fileExtension: ".pcm", voiceCompatible: true,
                audioStream: new ReadableStream({ start(controller) { controller.close(); } }),
                release() { store.getRuntime(); return Promise.resolve(); },
              }),
            }]; } };
          };`,
        );
        const cache = createPluginCache();
        const load = () =>
          withPluginCache(cache, () =>
            loadOpenClawPlugins({
              ...options,
              cache: false,
              capabilityCatalog: { family: "speechProviders", context: createContext() },
            }),
          );
        const context = { cfg: {}, providerConfig: {}, timeoutMs: 1000 };
        try {
          const retained = priorSuccess ? load().speechProviders[0]?.provider : undefined;
          const stream = await retained?.streamSynthesize?.({
            ...context,
            text: "synthetic",
            target: "audio-file",
          });
          const release = stream?.release;
          if (priorSuccess) {
            expect(retained?.isConfigured(context)).toBe(true);
            expect(release).toEqual(expect.any(Function));
            await release?.();
          }
          expect(load).toThrow(/capabilityCatalogEntry failed.*catalog construction failed/);
          const retried = priorSuccess ? load().speechProviders[0]?.provider : undefined;
          if (priorSuccess) {
            expect(retained?.isConfigured(context)).toBe(true);
            expect(retried?.isConfigured(context)).toBe(true);
          } else {
            // Failed initialization discards its loader; the next attempt starts fresh.
            expect(load).toThrow(/capabilityCatalogEntry failed.*catalog construction failed/);
          }
          await retirePluginCache(cache);
          if (priorSuccess) {
            expect(() => retained?.isConfigured(context)).toThrow(/reloaded|disabled|retir/);
            expect(() => retried?.isConfigured(context)).toThrow(/reloaded|disabled|retir/);
            expect(() => release?.()).toThrow(/reloaded|disabled|retir/);
          }
        } finally {
          await retirePluginCache(cache);
        }
      },
      {
        capabilityCatalogEntry: "./catalog.cjs",
        contracts: { speechProviders: ["factory-owner"] },
      },
    );
  },
);
