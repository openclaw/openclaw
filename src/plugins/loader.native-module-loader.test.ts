/** Verifies plugin loader behavior for native module loading and resolver hooks. */
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCompiledSdkHost } from "./compiled-sdk-host.test-support.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import { publishedSdkBridgeEntrypoints } from "./loader-sdk-bridge-artifacts.test-support.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginCache, resetPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  getPluginModuleLoaderStats,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

const tempDirs = createTempDirTracker();

function asPluginModuleLoaderFactory(factory: unknown): PluginModuleLoaderFactory {
  return factory as PluginModuleLoaderFactory;
}

function writeJavaScriptPluginFixture(id: string) {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
    "utf-8",
  );
  return pluginRoot;
}

function writePackagedPluginFixture(id: string) {
  const pluginRoot = writeJavaScriptPluginFixture(id);
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: id,
        type: "commonjs",
        openclaw: {
          extensions: ["./index.cjs"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return pluginRoot;
}

function writePreSplitSdkBridgeConsumerFixture() {
  const pluginRoot = tempDirs.make("openclaw-plugin-loader-");
  fs.mkdirSync(path.join(pluginRoot, "dist"));
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/sdk-bridge-consumer",
        version: "2026.7.2-beta.7",
        type: "module",
        openclaw: {
          extensions: ["./dist/index.js"],
          runtimeExtensions: ["./dist/index.js"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "sdk-bridge-consumer",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  // Import shapes copied from published 2026.7.2-beta.7 artifacts:
  // voice-call/matrix doctor contracts (runtime-doctor), whatsapp ack policy
  // (channel-feedback), slack progress-draft render (channel-outbound).
  // Covers both alias classes on purpose: runtime-doctor is private-local-only,
  // the channel subpaths are public. The host fixture supplies real compiled
  // SDK artifacts, matching the installed-package boundary.
  fs.writeFileSync(
    path.join(pluginRoot, "dist", "index.js"),
    [
      'import { archiveLegacyStateSource, detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema, detectPluginInstallPathIssue, formatPluginInstallPathIssue, removePluginFromConfig, createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";',
      'import { shouldAckReactionForWhatsApp } from "openclaw/plugin-sdk/channel-feedback";',
      'import { resolveChannelProgressDraftRender } from "openclaw/plugin-sdk/channel-outbound";',
      'export default { id: "sdk-bridge-consumer", register() {',
      "  const bridged = [",
      "    archiveLegacyStateSource,",
      "    detectOpenClawStateDatabaseSchemaMigrations,",
      "    repairOpenClawStateDatabaseSchema,",
      "    detectPluginInstallPathIssue,",
      "    formatPluginInstallPathIssue,",
      "    removePluginFromConfig,",
      "    createPluginStateSyncKeyedStore,",
      "    shouldAckReactionForWhatsApp,",
      "    resolveChannelProgressDraftRender,",
      "  ];",
      '  if (bridged.some((entry) => typeof entry !== "function")) throw new Error("missing bridge");',
      "} };",
    ].join("\n"),
    "utf-8",
  );
  return pluginRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginCache();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("createPluginModuleLoader", () => {
  it.each([
    { profile: false, throws: false },
    { profile: true, throws: false },
    { profile: false, throws: true },
    { profile: true, throws: true },
  ])(
    "preserves native loads with profiling=$profile and throws=$throws",
    async ({ profile, throws }) => {
      vi.stubEnv("OPENCLAW_DIAGNOSTICS", profile ? "plugin.load-profile" : "off");
      const pluginRoot = writeJavaScriptPluginFixture("profile-fixture");
      const modulePath = path.join(pluginRoot, "index.cjs");
      const expectedError = new Error("fixture evaluation failed");
      const errorKey = Symbol.for("openclaw.pluginLoadProfile.fixtureError");
      if (throws) {
        fs.writeFileSync(
          modulePath,
          'throw globalThis[Symbol.for("openclaw.pluginLoadProfile.fixtureError")];',
          "utf8",
        );
      }
      const stats = await import("./plugin-module-loader-cache.js");
      const readStats = vi.spyOn(stats, "getPluginModuleLoaderStats");
      const clock = vi.spyOn(performance, "now");
      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      const load = createPluginModuleLoader({ installNativeSdkResolver: false });
      try {
        if (throws) {
          Reflect.set(globalThis, errorKey, expectedError);
          let thrown: unknown;
          try {
            load(modulePath);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBe(expectedError);
        } else {
          const first = load(modulePath);
          expect(first).toMatchObject({ id: "profile-fixture" });
          expect(load(modulePath)).toBe(first);
        }
        const loads = throws ? 1 : 2;
        expect(readStats).toHaveBeenCalledTimes(profile ? loads * 2 : 0);
        if (!profile) {
          expect(clock).not.toHaveBeenCalled();
          expect(output).not.toHaveBeenCalled();
          return;
        }
        const lines = output.mock.calls.map(([line]) => line);
        expect(lines).toHaveLength(loads * 2);
        for (let index = 0; index < loads; index += 1) {
          expect(lines[index * 2]).toMatch(
            /^\[plugin-load-profile\] phase=module-loader-prepare plugin=\(core\) elapsedMs=\d+\.\d source=\(module\)$/,
          );
        }
        expect(lines[1]).toMatch(
          new RegExp(
            String.raw`^\[plugin-load-profile\] phase=module-load plugin=\(core\) elapsedMs=\d+\.\d calls=1 nativeHits=${throws ? 0 : 1} nativeMisses=0 sourceTransformForced=0 sourceTransformFallbacks=0 source=\(module\)$`,
          ),
        );
        if (!throws) {
          expect(lines[3]).toMatch(
            /^\[plugin-load-profile\] phase=module-load plugin=\(core\) elapsedMs=\d+\.\d calls=0 nativeHits=0 nativeMisses=0 sourceTransformForced=0 sourceTransformFallbacks=0 source=\(module\)$/,
          );
        }
      } finally {
        Reflect.deleteProperty(globalThis, errorKey);
      }
    },
  );

  it("loads bundled JavaScript natively without source transformation", () => {
    const pluginRoot = writeJavaScriptPluginFixture("demo");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginRoot);

    const before = getPluginModuleLoaderStats();
    const registry = loadOpenClawPlugins({
      cache: false,
      installRecords: {},
      workspaceDir: pluginRoot,
      onlyPluginIds: ["demo"],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
        },
      },
    });

    const after = getPluginModuleLoaderStats();
    expect(registry.plugins.find((plugin) => plugin.id === "demo")).toMatchObject({
      status: "loaded",
      origin: "bundled",
    });
    expect(after.nativeHits).toBeGreaterThan(before.nativeHits);
    expect(after.sourceTransformForced).toBe(before.sourceTransformForced);
    expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
  });

  it("loads packaged JavaScript natively without source transformation", () => {
    const pluginRoot = writePackagedPluginFixture("npm-demo");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", tempDirs.make("openclaw-plugin-loader-"));

    const before = getPluginModuleLoaderStats();
    const registry = loadOpenClawPlugins({
      cache: false,
      installRecords: {},
      onlyPluginIds: ["npm-demo"],
      config: {
        plugins: {
          enabled: true,
          load: {
            paths: [pluginRoot],
          },
          allow: ["npm-demo"],
          entries: {
            "npm-demo": {
              enabled: true,
            },
          },
        },
      },
    });

    const after = getPluginModuleLoaderStats();
    expect(registry.plugins.find((plugin) => plugin.id === "npm-demo")?.status).toBe("loaded");
    expect(after.nativeHits).toBeGreaterThan(before.nativeHits);
    expect(after.sourceTransformForced).toBe(before.sourceTransformForced);
    expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
  });

  it("loads published pre-split SDK bridge imports (doctor repair, WhatsApp ack, Slack render)", () => {
    const pluginRoot = writePreSplitSdkBridgeConsumerFixture();
    const [entrypoint] = publishedSdkBridgeEntrypoints;
    const hostRoot = createCompiledSdkHost(entrypoint, (prefix) => tempDirs.make(prefix));
    const hasCompiledSdk = hostRoot !== undefined;
    if (hasCompiledSdk) {
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", hostRoot);
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(hostRoot, "extensions"));
    } else {
      // Standalone and watch-mode Vitest deliberately retain source declarations.
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", tempDirs.make("openclaw-plugin-loader-"));
    }
    const before = getPluginModuleLoaderStats();

    const registry = loadOpenClawPlugins({
      cache: false,
      pluginSdkResolution: hasCompiledSdk ? "dist" : "auto",
      onlyPluginIds: ["sdk-bridge-consumer"],
      config: {
        plugins: {
          enabled: true,
          load: { paths: [pluginRoot] },
          allow: ["sdk-bridge-consumer"],
          entries: { "sdk-bridge-consumer": { enabled: true } },
        },
      },
    });

    const entry = registry.plugins.find((plugin) => plugin.id === "sdk-bridge-consumer");
    expect(entry?.error ?? null).toBeNull();
    expect(entry?.status).toBe("loaded");
    if (hasCompiledSdk) {
      const after = getPluginModuleLoaderStats();
      expect(after.nativeHits).toBeGreaterThan(before.nativeHits);
      expect(after.sourceTransformFallbacks).toBe(before.sourceTransformFallbacks);
    }
  });

  it("reuses successful source-transform module exports inside one loader", async () => {
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "plugin.load-profile");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const moduleExport = { marker: "source-cached" };
    const fromSourceTransformer = vi.fn(() => moduleExport);
    const createJiti = vi.fn(() => fromSourceTransformer);
    const nativeStub = vi.fn(() => ({ ok: true, moduleExport: { fromNative: true } }));
    try {
      vi.doMock("./native-module-require.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./native-module-require.js")>()),
        tryNativeRequireJavaScriptModule: nativeStub,
      }));
      const { getCachedPluginModuleLoader, getPluginModuleLoaderStats: getFreshLoaderStats } =
        await importFreshModule<typeof import("./plugin-module-loader-cache.js")>(
          import.meta.url,
          "./plugin-module-loader-cache.js?scope=native-loader-source-export-profile",
        );
      const loader = withPluginCache(createPluginCache(), () =>
        getCachedPluginModuleLoader({
          modulePath: "/repo/extensions/demo/api.ts",
          importerUrl: "file:///repo/src/plugins/bundled-capability-runtime.ts",
          loaderFilename: "file:///repo/src/plugins/bundled-capability-runtime.ts",
          tryNative: false,
          createLoader: asPluginModuleLoaderFactory(createJiti),
        }),
      );

      expect(loader("/repo/extensions/demo/api.ts")).toBe(moduleExport);
      expect(loader("/repo/extensions/demo/api.ts")).toBe(moduleExport);
      expect(loader("/repo/extensions/demo/other.ts")).toBe(moduleExport);
      expect(nativeStub).not.toHaveBeenCalled();
      expect(createJiti).toHaveBeenCalledOnce();
      expect(fromSourceTransformer).toHaveBeenCalledTimes(2);
      const stats = getFreshLoaderStats();
      expect(stats).toMatchObject({
        calls: 2,
        nativeHits: 0,
        nativeMisses: 0,
        sourceTransformFallbacks: 0,
        sourceTransformForced: 2,
      });
      expect(stats.topSourceTransformTargets).toEqual([
        { target: "/repo/extensions/demo/api.ts", count: 1 },
        { target: "/repo/extensions/demo/other.ts", count: 1 },
      ]);
      expect(output).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /^\[plugin-load-profile\] phase=source-transform-prepare plugin=\(core\) elapsedMs=\d+\.\d source=\(module\)$/,
        ),
      );
    } finally {
      vi.doUnmock("./native-module-require.js");
    }
  });

  it("preserves transform preparation errors while profiling", async () => {
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "plugin.load-profile");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const expectedError = new Error("fixture preparation failed");
    const createLoader = vi.fn(() => {
      throw expectedError;
    });
    const { getCachedPluginModuleLoader } = await importFreshModule<
      typeof import("./plugin-module-loader-cache.js")
    >(
      import.meta.url,
      "./plugin-module-loader-cache.js?scope=native-loader-source-preparation-error",
    );
    const loader = withPluginCache(createPluginCache(), () =>
      getCachedPluginModuleLoader({
        modulePath: "/repo/extensions/demo/api.ts",
        importerUrl: import.meta.url,
        aliasMap: {},
        tryNative: false,
        createLoader: asPluginModuleLoaderFactory(createLoader),
      }),
    );
    let thrown: unknown;
    try {
      loader("/repo/extensions/demo/api.ts");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(expectedError);
    expect(createLoader).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^\[plugin-load-profile\] phase=source-transform-prepare plugin=\(core\) elapsedMs=\d+\.\d source=\(module\)$/,
      ),
    );
  });
});
