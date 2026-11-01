import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi, afterAll, describe } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPreparedInboundRegistryLoader } from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { selectCurrentPluginMetadataCache } from "./current-plugin-metadata-state.js";
import { createHookRunner } from "./hooks.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  disposeLoaderFixtures,
  pluginFixtureConfig,
  writeFixtureJson,
  callFixtureGatewayMethod,
} from "./loader-fixture-builders.test-support.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadOpenClawPlugins, acquirePluginRegistryForInspection } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
} from "./loader.test-fixtures.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
  resetPluginCache,
  waitForPluginCacheRetirement,
  retirePluginCache,
} from "./plugin-cache.js";
import * as preparation from "./plugin-generation-worker.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { capturePluginRuntimeRecovery } from "./plugin-runtime-artifact-binding.js";
import { getSharedPluginCodeReloadWarning } from "./plugin-shared-module-loader.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryGatewayOwner } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

describe("runtime recovery", () => {
  const registries: PluginRegistry[] = [];
  afterEach(async () => {
    await disposeLoaderFixtures(registries);
    resetPluginLoaderTestStateForTest();
  });

  function load(options: PluginLoadOptions) {
    const registry = loadOpenClawPlugins({ activate: false, cache: false, ...options });
    registries.push(registry);
    return registry;
  }

  function resolveProbe(registry: PluginRegistry) {
    const tool = registry.tools
      .find((entry) => entry.names.includes("recovery_inbound_probe"))
      ?.factory({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one recovered inbound probe tool");
    }
    return tool;
  }

  it.each(["installed", "bundled-mjs"] as const)(
    "publishes fresh %s recovery for inbound work without another registration",
    async (kind) => {
      const root = makePluginLoaderTempDir();
      const bundled = kind !== "installed";
      const extension = kind === "bundled-mjs" ? "mjs" : "cjs";
      const bundledDir = path.join(root, "bundled");
      const id = "recovery-inbound";
      const plugin = writePlugin({
        id,
        dir: path.join(bundled ? bundledDir : root, id),
        filename: `index.${extension}`,
        configSchema: {
          type: "object",
          properties: { marker: { type: "string" }, fail: { type: "boolean" } },
        },
        body: `let registrations = 0;
        ${extension === "mjs" ? "export default" : "module.exports ="} {
          id: ${JSON.stringify(id)},
          register(api) {
            const registration = ++registrations;
            const lifetime = new AbortController();
            api.lifecycle.onDispose(() => lifetime.abort());
            if (api.pluginConfig.fail) throw new Error('replacement registration failed');
            api.registerTool({ name: 'recovery_inbound_probe', description: 'Read recovered owner',
              parameters: { type: 'object', properties: {} },
              execute() {
                lifetime.signal.throwIfAborted();
                return { content: [{ type: 'text', text: api.pluginConfig.marker + ':' + registration }] };
              }
            });
          }
        };`,
      });
      const configWith = (marker = "original", fail = false): OpenClawConfig => ({
        plugins: {
          allow: [id],
          slots: { memory: "none" },
          ...(!bundled ? { load: { paths: [plugin.dir] } } : {}),
          entries: { [id]: { enabled: true, config: { marker, fail } } },
        },
      });
      const config = configWith();
      const context = { config, workspaceDir: root };
      const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      writeFixtureJson(plugin.dir, "openclaw.plugin.json", {
        ...manifest,
        contracts: { tools: ["recovery_inbound_probe"] },
      });
      const previousCache = getProcessPluginCache();
      await using operationCache = createPluginCache();
      await using publishedCache = createPluginCache();
      try {
        await withEnvAsync(
          {
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundled ? bundledDir : undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: bundled ? undefined : "1",
          },
          async () => {
            const metadata = withPluginCache(publishedCache, () =>
              loadPluginMetadataSnapshot(context),
            );
            bindPluginMetadataSnapshotCache(metadata, publishedCache);
            const options = {
              ...context,
              manifestRegistry: metadata.manifestRegistry,
              discovery: metadata.discovery,
              runtimeSideEffects: true,
              throwOnLoadError: true,
            };
            const previous = withPluginCache(publishedCache, () => load(options));
            const oldRecord = previous.plugins.find((record) => record.id === id)!;
            expect(oldRecord.origin).toBe(bundled ? "bundled" : "config");
            const oldTool = resolveProbe(previous);
            expect(await oldTool.execute("previous", {})).toMatchObject({
              content: [{ text: "original:1" }],
            });
            const recovery = capturePluginRuntimeRecovery(oldRecord)!;
            try {
              await disposePluginRegistryInstances(previous);
              const candidate = withPluginCache(operationCache, () =>
                load({
                  ...options,
                  config: configWith("replacement", true),
                  previousRegistry: previous,
                  throwOnLoadError: false,
                }),
              );
              expect(candidate.plugins.find((record) => record.id === id)?.error).toContain(
                "replacement registration failed",
              );
              await disposePluginRegistryInstances(candidate);
              if (!bundled) {
                fs.writeFileSync(
                  plugin.file,
                  "throw new Error('current package must not run during recovery');",
                );
                fs.rmSync(plugin.dir, { recursive: true });
              }
              await withPluginCache(operationCache, async () => {
                const restored = load({
                  ...options,
                  previousRegistry: previous,
                  moduleRecoveries: new Map([[id, recovery]]),
                });
                prepareOwnedPluginLoadContext(context, process.env, restored, metadata);
                bindPluginRegistryGatewayOwner(restored, { current: () => restored });
                setActivePluginRegistry(restored, undefined, "gateway-bindable", root);
                setGatewayPluginMetadataSnapshot(metadata, context);
                expect(
                  getCurrentPluginMetadataSnapshot({
                    ...context,
                    allowWorkspaceScopedSnapshot: true,
                  }),
                ).toBeUndefined();
                const restoredTool = resolveProbe(restored);
                const expected = { content: [{ text: bundled ? "original:3" : "original:1" }] };
                expect(await restoredTool.execute("recovered", {})).toMatchObject(expected);
                expect(() => oldTool.execute("retired", {})).toThrow(/reloaded or disabled/);

                const loadInbound = createPreparedInboundRegistryLoader();
                for (let pass = 0; pass < 2; pass++) {
                  const inbound = withPluginRuntimeRegistryScope(restored, () =>
                    loadInbound({ ...context, allowGatewaySubagentBinding: true }, metadata),
                  );
                  expect(inbound).toBe(restored);
                  expect(await resolveProbe(inbound).execute("inbound", {})).toMatchObject(
                    expected,
                  );
                }
              });
            } finally {
              await recovery.module.dispose();
            }
          },
        );
      } finally {
        await clearActivePluginRegistry();
        await disposeLoaderFixtures(registries);
        selectCurrentPluginMetadataCache(previousCache);
      }
    },
  );

  it("joins a failed candidate's declared stop hook before recovering the previous resource owner", async () => {
    useNoBundledPlugins();
    const lock = path.join(makePluginLoaderTempDir(), "owned.lock");
    const gate = createDeferredCore();
    const plugin = writePlugin({
      id: "failed-resource-owner",
      configSchema: { type: "object", properties: { fail: { type: "boolean" } } },
      registration: `const fs = require('node:fs');
        const lock = ${JSON.stringify(lock)};
        const fd = fs.openSync(lock, 'wx');
        api.on('gateway_stop', async () => {
          require('./close.cjs').close(fd, lock);
        });
        if (api.pluginConfig.fail) throw new Error('candidate registration failed');
    `,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "close.cjs"),
      "exports.close = (fd, lock) => { const fs = require('node:fs'); fs.closeSync(fd); fs.unlinkSync(lock); };",
    );
    const config = pluginFixtureConfig(plugin, { config: { fail: false } });
    const options = { config, runtimeSideEffects: true };
    let recovery: ReturnType<typeof capturePluginRuntimeRecovery>;
    const stop = (registry: PluginRegistry) =>
      createHookRunner(registry, { catchErrors: false }).runGatewayStop(
        { reason: "plugin replacement" },
        { port: 0, config, getCron: () => undefined },
      );
    try {
      const old = load(options);
      recovery = capturePluginRuntimeRecovery(old.plugins[0]!);
      const manifestRegistry = getPluginRuntimeLoadContext(old)!.manifestRegistry;
      await stop(old);
      await disposePluginRegistryInstances(old);
      const candidate = load({
        ...options,
        config: pluginFixtureConfig(plugin, { config: { fail: true } }),
        manifestRegistry,
        previousRegistry: old,
        prepareRegistrationFailureCleanup(registry, record) {
          const hooks = createEmptyPluginRegistry();
          hooks.typedHooks = registry.typedHooks.filter(
            (hook) => hook.pluginId === record.id && hook.hookName === "gateway_stop",
          );
          getPluginInstance(record)!.lifecycle.onDispose(async () => {
            await gate.promise;
            await stop(hooks);
          });
        },
      });
      expect(candidate.plugins[0]!.error).toContain("candidate registration failed");
      expect(candidate.typedHooks).toEqual([]);
      expect(fs.existsSync(lock)).toBe(true);
      let retired = false;
      const retirement = disposePluginRegistryInstances(candidate).then(() => {
        retired = true;
      });
      await Promise.resolve();
      expect(retired).toBe(false);
      gate.resolve();
      await retirement;
      expect(fs.existsSync(lock)).toBe(false);

      const restored = load({
        ...options,
        manifestRegistry,
        previousRegistry: old,
        moduleRecoveries: new Map([[plugin.id, recovery!]]),
        throwOnLoadError: true,
      });
      expect(restored.plugins[0]!.status).toBe("loaded");
      expect(fs.existsSync(lock)).toBe(true);
      await stop(restored);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      gate.resolve();
      await recovery?.module.dispose();
      await disposeLoaderFixtures(registries);
    }
  });

  it("preserves the registration error and disposes resources when cleanup preparation also fails", async () => {
    useNoBundledPlugins();
    const marker = path.join(makePluginLoaderTempDir(), "disposed");
    const plugin = writePlugin({
      id: "cleanup-preparation-failure",
      registration: `api.lifecycle.onDispose(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'disposed'));
      throw new Error('original registration failure');`,
    });
    const registry = load({
      config: pluginFixtureConfig(plugin),
      prepareRegistrationFailureCleanup() {
        throw new Error("cleanup preparation failure");
      },
    });
    expect(registry.plugins[0]!.error).toContain("original registration failure");
    expect(registry.plugins[0]!.error).toContain("cleanup preparation failure");
    await disposePluginRegistryInstances(registry);
    expect(fs.readFileSync(marker, "utf8")).toBe("disposed");
  });
});

describe("module recovery", () => {
  const temp = useAutoCleanupTempDirTracker(afterEach);
  const instances: PluginInstance[] = [];
  function newInstance(
    id = "recovery-fixture",
    binding?: Omit<Parameters<typeof bindPluginInstanceModuleLoader>[0], "instance">,
  ) {
    const instance = new PluginInstance(id);
    instances.push(instance);
    if (binding) {
      bindPluginInstanceModuleLoader({ ...binding, instance });
    }
    return instance;
  }
  function capture(instance: PluginInstance, captures: string) {
    return withPluginSourceCaptureDirectory(captures, () => instance.captureModuleLoaderRecovery());
  }
  function expectIdentity(filename: string, identity: fs.Stats) {
    expect(fs.statSync(filename)).toMatchObject({ dev: identity.dev, ino: identity.ino });
  }
  afterEach(async () => {
    for (const instance of instances.splice(0).toReversed()) {
      await instance.dispose();
    }
    resetPluginCache();
    await waitForPluginCacheRetirement();
    vi.restoreAllMocks();
  });

  function fixture(standalone = false, nativePackageMap = false) {
    const root = temp.make("plugin-recovery-source-");
    const captures = temp.make("plugin-recovery-captures-");
    const entry = path.join(root, "index.cjs");
    writeArtifacts(root, {
      "package.json": {
        name: "recovery-fixture",
        dependencies: { "recovery-dependency": "1.0.0", "native-recovery": "1.0.0" },
      },
      "node_modules/recovery-dependency/package.json": {
        name: "recovery-dependency",
        main: "index.cjs",
      },
      "node_modules/recovery-dependency/index.cjs": "exports.value = 'original dependency';",
      "node_modules/native-recovery/package.json": {
        name: "native-recovery",
        ...(nativePackageMap ? { exports: "./native.node" } : { main: "native.node" }),
      },
      "node_modules/native-recovery/native.node": "original native dependency",
      "late.cjs": "exports.value = 'original late import';",
      "native.so": "original native bytes",
      "index.cjs": `const dependency = require('recovery-dependency');
     const fs = require('node:fs');
     const path = require('node:path');
     let count = 0;
     exports.next = () => ++count;
     exports.dependency = () => dependency.value;
     exports.nativeDependencyPath = () => require.resolve('native-recovery');
     exports.nativePath = path.join(__dirname, 'native.so');
     exports.native = () => fs.readFileSync(path.join(__dirname, 'native.so'), 'utf8');
     exports.late = () => require('./late.cjs').value;`,
    });
    const create = () =>
      withPluginSourceCaptureDirectory(captures, () =>
        newInstance("recovery-fixture", {
          origin: "global",
          source: entry,
          rootDir: root,
          standalone,
        }),
      );
    return { root, entry, captures, instance: create(), create };
  }

  type FixtureModule = {
    next(): number;
    dependency(): string;
    late(): string;
    native(): string;
    nativePath: string;
    nativeDependencyPath(): string;
  };

  it.each([
    { standalone: false, nativePackageMap: false, denyFileSymlinks: false },
    { standalone: true, nativePackageMap: true, denyFileSymlinks: true },
  ])(
    "recovers native assets after package removal (standalone: $standalone, exports: $nativePackageMap, file-symlink denied: $denyFileSymlinks)",
    async ({ standalone, nativePackageMap, denyFileSymlinks }) => {
      let deniedLinks = 0;
      if (denyFileSymlinks) {
        const symlink = fs.symlinkSync;
        vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
          if (type === "file") {
            deniedLinks += 1;
            throw Object.assign(
              new Error("fixture Windows file symlink privilege is unavailable"),
              {
                code: "EPERM",
              },
            );
          }
          symlink(target, link, type);
        });
      }
      const { root, entry, captures, instance, create } = fixture(standalone, nativePackageMap);
      const oldModule = instance.loadModule(entry) as FixtureModule;
      expect([oldModule.next(), oldModule.next()]).toEqual([1, 2]);
      expect(oldModule.native()).toBe("original native bytes");
      const nativeIdentity = fs.statSync(oldModule.nativePath);
      const dependencyIdentity = fs.statSync(oldModule.nativeDependencyPath());
      if (denyFileSymlinks) {
        const warm = create();
        const warmModule = warm.loadModule(entry) as FixtureModule;
        expect(warmModule.native()).toBe("original native bytes");
        expectIdentity(warmModule.nativePath, nativeIdentity);
        expect(fs.readFileSync(warmModule.nativeDependencyPath(), "utf8")).toBe(
          "original native dependency",
        );
        await warm.dispose();
        expect(oldModule.native()).toBe("original native bytes");
      }
      const nativeRead = vi.spyOn(fs, "readFileSync");
      const nativeShadow = fs.realpathSync(oldModule.nativePath);
      fs.writeFileSync(path.join(root, "native.so"), "replacement native bytes");
      expect(oldModule.native()).toBe("original native bytes");
      const recovery = capture(instance, captures);
      fs.writeFileSync(entry, "throw new Error('replacement code must not run during recovery');");
      await instance.dispose();
      fs.rmSync(root, { recursive: true });

      const restored = newInstance();
      withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
      await recovery.dispose();
      const restoredModule = restored.loadModule(entry) as FixtureModule;
      expect(restoredModule.next()).toBe(1);
      expect(restoredModule.dependency()).toBe("original dependency");
      expect(restoredModule.late()).toBe("original late import");
      expect(restoredModule.native()).toBe("original native bytes");
      expectIdentity(restoredModule.nativePath, nativeIdentity);
      expect(fs.readFileSync(restoredModule.nativeDependencyPath(), "utf8")).toBe(
        "original native dependency",
      );
      expectIdentity(restoredModule.nativeDependencyPath(), dependencyIdentity);
      expect(() => oldModule.next()).toThrow();

      // Recovery remains recoverable itself after another failed update.
      const again = capture(restored, captures);
      await restored.dispose();
      const final = newInstance();
      withPluginSourceCaptureDirectory(captures, () => again.bind(final));
      const finalModule = final.loadModule(entry) as FixtureModule;
      expect(finalModule.next()).toBe(1);
      expect(finalModule.late()).toBe("original late import");
      expect(finalModule.native()).toBe("original native bytes");
      expectIdentity(finalModule.nativePath, nativeIdentity);
      await final.dispose();
      expect(fs.readdirSync(captures)).toEqual([]);
      expect(
        nativeRead.mock.calls.filter(([source], index) => {
          const result = nativeRead.mock.results[index];
          return (
            /(?:native\.so|native\.node)$/.test(String(source)) &&
            result?.type === "return" &&
            Buffer.isBuffer(result.value)
          );
        }),
      ).toHaveLength(0);
      if (denyFileSymlinks) {
        expect(deniedLinks).toBeGreaterThan(0);
      }
      resetPluginCache();
      await waitForPluginCacheRetirement();
      expect(fs.existsSync(nativeShadow)).toBe(false);
    },
  );

  it("releases unused recovery custody without disturbing the active loader", async () => {
    const { entry, captures, instance } = fixture();
    const before = fs.readdirSync(captures);
    const recovery = capture(instance, captures);
    expect(fs.readdirSync(captures).length).toBeGreaterThan(before.length);
    await recovery.dispose();
    await recovery.dispose();
    expect(fs.readdirSync(captures)).toEqual(before);
    expect((instance.loadModule(entry) as FixtureModule).next()).toBe(1);
    expect(() => recovery.bind(new PluginInstance("recovery-fixture"))).toThrow("released");
  });

  it("captures quiesced code without admitting calls and refuses capture after disposal starts", async () => {
    const { root, entry, captures, instance } = fixture();
    expect((instance.loadModule(entry) as FixtureModule).dependency()).toBe("original dependency");
    instance.quiesce();
    fs.writeFileSync(entry, "throw new Error('changed disk bytes must not become recovery');");
    const recovery = capture(instance, captures);
    expect(() => instance.loadModule(entry)).toThrow(/reloaded or disabled/);
    const disposing = instance.dispose();
    expect(() => instance.captureModuleLoaderRecovery()).toThrow(/reloaded or disabled/);
    await disposing;
    fs.rmSync(root, { recursive: true });
    const restored = newInstance(instance.pluginId);
    recovery.bind(restored);
    await recovery.dispose();
    expect((restored.loadModule(entry) as FixtureModule).dependency()).toBe("original dependency");
    expect((restored.loadModule(entry) as FixtureModule).late()).toBe("original late import");
  });

  it("shares bundled TypeScript code without captures and warns when edited code needs a restart", () => {
    const root = temp.make("bundled-source-identity-");
    const captures = temp.make("bundled-source-captures-");
    const entry = path.join(root, "index.ts");
    const writeEntry = (value: number) =>
      fs.writeFileSync(
        entry,
        `import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
       export const value: number = ${value};
       export const schema = emptyPluginConfigSchema().jsonSchema;`,
      );
    const load = () => {
      const { instance, value } = withPluginSourceCaptureDirectory(captures, () => {
        const created = newInstance("bundled-source", {
          origin: "bundled",
          source: entry,
          rootDir: root,
        });
        return { instance: created, value: created.loadModule(entry) };
      });
      expect(instance.sourceDigest).toBeUndefined();
      expect(fs.readdirSync(captures)).toEqual([]);
      expect(value).toMatchObject({ value: 1, schema: { type: "object" } });
      return instance;
    };

    writeEntry(1);
    expect(getSharedPluginCodeReloadWarning(load())).toBeUndefined();
    resetPluginCache();
    writeEntry(2);
    expect(getSharedPluginCodeReloadWarning(load())).toBe(
      "Bundled plugin code remains loaded. Restart the Gateway to load edited code.",
    );
  });

  it.each(["cjs", "mjs"])(
    "reuses bundled %s code while giving recovery fresh callback authority",
    async (extension) => {
      const root = temp.make("bundled-recovery-identity-");
      const entry = path.join(root, `index.${extension}`);
      fs.writeFileSync(
        entry,
        `let registrations = 0;
       ${extension === "mjs" ? "export const register =" : "exports.register ="} () => {
         const registration = ++registrations;
         return () => registration;
       };`,
      );
      type BundledModule = { register(): () => number };
      const previous = newInstance("bundled-recovery", {
        origin: "bundled",
        source: entry,
        rootDir: root,
      });
      const oldCallback = (previous.loadModule(entry) as BundledModule).register();
      expect(oldCallback()).toBe(1);
      expect(getSharedPluginCodeReloadWarning(previous)).toBeUndefined();
      const recovery = previous.captureModuleLoaderRecovery();
      await previous.dispose();
      fs.rmSync(root, { recursive: true });

      const restored = newInstance(previous.pluginId);
      recovery.bind(restored);
      await recovery.dispose();
      const restoredCallback = (restored.loadModule(entry) as BundledModule).register();
      expect(restoredCallback()).toBe(2);
      expect(getSharedPluginCodeReloadWarning(restored)).toBeUndefined();
      expect(oldCallback).toThrow(/reloaded or disabled/);
      expect(restoredCallback()).toBe(2);

      const secondRecovery = restored.captureModuleLoaderRecovery();
      await restored.dispose();
      const final = newInstance(previous.pluginId);
      secondRecovery.bind(final);
      await secondRecovery.dispose();
      expect((final.loadModule(entry) as BundledModule).register()()).toBe(3);
      expect(restoredCallback).toThrow(/reloaded or disabled/);
    },
  );
});

describe("main-thread inspection authority", () => {
  const PLUGIN_ID = "main-inspection-authority";
  const authority = Symbol.for("openclaw.test.mainInspectionAuthority");

  type AuthoritySlot = {
    evaluations: number;
    registrations: number;
    effects: number;
    gate: PromiseWithResolvers<void>;
    stale?: Promise<void>;
    neighborError?: string;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, authority);
    try {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      resetPluginLoaderTestStateForTest();
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
  afterAll(cleanupPluginLoaderFixturesForTest);

  const providers = (registry: PluginRegistry) =>
    registry.providers.map(({ provider }) => `${provider.id}:${provider.label}`).toSorted();

  /** Writes a global native ESM plugin and runs cold main-thread inspections against it. */
  async function withInstalledEsmPlugin(
    files: Record<string, string>,
    run: (fixture: {
      pluginDir: string;
      install: (record: Omit<PluginInstallRecord, "installPath">) => Promise<void>;
      inspect: (
        workspace: string,
        pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"],
      ) => ReturnType<typeof acquirePluginRegistryForInspection>;
      publish: () => ReturnType<typeof createPluginCache>;
    }) => Promise<void>,
  ) {
    expect(isMainThread).toBe(true);
    useNoBundledPlugins();
    const stateDir = fs.realpathSync(makePluginLoaderTempDir());
    const pluginDir = path.join(stateDir, "extensions", PLUGIN_ID);
    fs.mkdirSync(pluginDir, { recursive: true });
    writeFixtureJson(pluginDir, "package.json", {
      name: `@vendor/${PLUGIN_ID}`,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    });
    writeFixtureJson(pluginDir, "openclaw.plugin.json", {
      id: PLUGIN_ID,
      configSchema: EMPTY_PLUGIN_SCHEMA,
      providers: ["fixture-provider"],
    });
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(pluginDir, name), source);
    }
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: Object.fromEntries(
          ["main", "research", "concurrent"].map((id) => [
            id,
            { workspace: path.join(stateDir, "workspace", id) },
          ]),
        ),
      },
      plugins: {
        allow: [PLUGIN_ID],
        entries: { [PLUGIN_ID]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot(config);
      const previous = getProcessPluginCache();
      const inventories: ReturnType<typeof createPluginCache>[] = [];
      const inspections: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>[] = [];
      try {
        await withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
          run({
            pluginDir,
            install: (record) =>
              refreshPersistedInstalledPluginIndex({
                reason: "source-changed",
                installRecords: { [PLUGIN_ID]: { ...record, installPath: pluginDir } },
              }).then(() => undefined),
            inspect: async (workspace, pluginSdkResolution) => {
              const inspection = await acquirePluginRegistryForInspection({
                config,
                workspaceDir: path.join(stateDir, "workspace", workspace),
                pluginSdkResolution,
                throwOnLoadError: true,
              });
              inspections.push(inspection);
              return inspection;
            },
            publish: () => {
              const inventory = createPluginCache();
              inventories.push(inventory);
              const options = { config, workspaceDir: path.join(stateDir, "gateway") };
              const snapshot = withPluginCache(inventory, () =>
                loadPluginMetadataSnapshot({ ...options, allowCurrent: false }),
              );
              setGatewayPluginMetadataSnapshot(snapshot, options);
              return inventory;
            },
          }),
        );
      } finally {
        selectCurrentPluginMetadataCache(previous);
        for (const inspection of inspections.toReversed()) {
          await inspection.release();
        }
        for (const inventory of inventories.toReversed()) {
          await retirePluginCache(inventory);
        }
      }
    });
  }

  const npmInstall = (integrity: string, installedAt: string) =>
    ({
      source: "npm",
      spec: `@vendor/${PLUGIN_ID}@1.0.0`,
      resolvedSpec: `@vendor/${PLUGIN_ID}@1.0.0`,
      integrity,
      installedAt,
    }) as const;

  it("reuses only published workspace code while preserving inspection authority and capture lifetime", async () => {
    await withInstalledEsmPlugin(
      {
        "index.mjs": `const slot = (globalThis[Symbol.for("openclaw.test.mainInspectionAuthority")] ??= {
  evaluations: 0, registrations: 0, effects: 0, gate: Promise.withResolvers(),
});
slot.evaluations++;
let latestApi;
const call = () => {
  latestApi.registerProvider({ id: "foreign-provider", label: "Foreign", auth: [] });
  slot.effects++;
};
slot.call ??= call;
export function register(api) {
  latestApi = api;
  slot.registrations++;
  api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [] });
  api.registerGatewayMethod("fixture.read", async ({ respond }) => {
    const { value } = await import("./lazy.mjs");
    respond(true, value);
  });
  if (slot.registrations === 1) {
    slot.stale = slot.gate.promise.then(call);
    slot.stale.catch(() => {});
  } else if (slot.registrations === 4) {
    try { slot.call(); } catch (error) { slot.neighborError = error.message; }
  }
}
`,
        "lazy.mjs": 'export const value = "lazy";',
      },
      async ({ install, inspect, publish }) => {
        await install(npmInstall("sha512-authority", "2026-10-20T00:00:00.000Z"));
        const inventory = publish();
        const prepareArtifact = preparation.preparePluginGenerationArtifact;
        const prepare = vi
          .spyOn(preparation, "preparePluginGenerationArtifact")
          .mockImplementation(async (...args) => {
            const prepared = await prepareArtifact(...args);
            vi.spyOn(prepared.artifact, "disposeAsync");
            return prepared;
          });
        const retired = await inspect("main");
        const artifact = (await prepare.mock.results[0]!.value).artifact;
        await retired.release();
        const replacement = await inspect("main");
        // SAFETY: The fixture module initializes this slot during its first evaluation.
        const slot = (globalThis as Record<symbol, AuthoritySlot>)[authority]!;
        expect(replacement.registry.plugins[0]).toMatchObject({
          origin: "global",
          status: "loaded",
        });
        expect(slot).toMatchObject({ evaluations: 1, registrations: 2 });
        const readLazy = async (inspection: typeof replacement) => {
          const respond = await callFixtureGatewayMethod(
            inspection.registry.gatewayHandlers["fixture.read"]!,
            "fixture.read",
          );
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, "lazy", undefined, undefined);
        };
        await readLazy(replacement);
        const overlapping = await inspect("main");

        const neighbor = await inspect("research");
        expect(slot).toMatchObject({ evaluations: 2, registrations: 4 });
        expect(slot.neighborError).toContain("calling workspace generation");

        slot.gate.resolve();
        await expect(slot.stale).rejects.toThrow("calling workspace generation");
        expect(slot.effects).toBe(0);
        expect(providers(replacement.registry)).toEqual(["fixture-provider:Fixture"]);
        expect(providers(neighbor.registry)).toEqual(["fixture-provider:Fixture"]);

        const beforeConcurrent = prepare.mock.calls.length;
        const [left, right] = await Promise.all([inspect("concurrent"), inspect("concurrent")]);
        expect(slot.evaluations).toBe(3);
        const contenders = await Promise.all(
          prepare.mock.results.slice(beforeConcurrent).map(({ value }) => value),
        );
        expect(
          contenders.filter(
            (contender) => vi.mocked(contender.artifact.disposeAsync).mock.calls.length > 0,
          ),
        ).toHaveLength(1);
        await left.release();
        await readLazy(right);
        for (const expected of [4, 5]) {
          const unknown = await inspect("unconfigured");
          expect(slot.evaluations).toBe(expected);
          await unknown.release();
        }
        for (let pass = 0; pass < 2; pass++) {
          const sourceSdk = await inspect("main", "src");
          expect(slot.evaluations).toBe(6);
          await sourceSdk.release();
        }

        await retirePluginCache(inventory);
        expect(artifact.disposeAsync).not.toHaveBeenCalled();
        await readLazy(replacement);
        await Promise.all([
          replacement.release(),
          overlapping.release(),
          neighbor.release(),
          right.release(),
        ]);
        expect(artifact.disposeAsync).toHaveBeenCalledTimes(1);
      },
    );
  }, 120_000);

  // Editable global installs (local or archive sources) and reinstalled npm packages must
  // expose edited sources, including imported helpers, to the next cold inspection.
  it.each([
    {
      name: "an editable archive install",
      before: { source: "archive" } as const,
      after: { source: "archive" } as const,
    },
    {
      name: "a reinstalled npm package",
      before: npmInstall("sha512-before", "2026-10-20T00:00:00.000Z"),
      after: npmInstall("sha512-after", "2026-10-20T01:00:00.000Z"),
    },
  ])(
    "loads edited sources for the next inspection of $name",
    async ({ before, after }) => {
      await withInstalledEsmPlugin(
        {
          "index.mjs": `import { label } from "./label.mjs";
export function register(api) {
  api.registerProvider({ id: "fixture-provider", label, auth: [] });
}
`,
          "label.mjs": 'export const label = "before";',
        },
        async ({ pluginDir, install, inspect, publish }) => {
          await install(before);
          publish();
          const first = await inspect("main");
          expect(providers(first.registry)).toEqual(["fixture-provider:before"]);
          fs.writeFileSync(path.join(pluginDir, "label.mjs"), 'export const label = "after";');
          await install(after);
          publish();
          const second = await inspect("main");
          expect(providers(second.registry)).toEqual(["fixture-provider:after"]);
        },
      );
    },
    120_000,
  );
});
