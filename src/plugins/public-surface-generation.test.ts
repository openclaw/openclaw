import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  MissingPublicSurfaceError,
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSyncCore,
  resetFacadeLoaderStateForTest,
} from "../plugin-sdk/facade-loader.js";
import {
  loadActivatedBundledPluginPublicSurfaceModule,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  testing as facadeRuntimeTesting,
} from "../plugin-sdk/facade-runtime.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import { adoptProcessPluginCache, createPluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginInstance, getPluginValueInstance } from "./plugin-instance-scope.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { loadPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import { writeArtifact } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, stageActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import { resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";

type PublicApi = {
  read: () => string;
  view: { read: () => string; frozen: readonly (() => string)[] };
};
const temp = createTempDirTracker();
const records: PluginRecord[] = [];

function write(root: string, file: string, content: string) {
  writeArtifact(path.join(root, file), content);
}

const makeRoot = () => fs.realpathSync(temp.make("openclaw-public-surface-"));

function loadApi(pluginRoot: string, pluginId?: string, origin?: "global" | "bundled") {
  return loadPluginPublicArtifactModuleSync<PublicApi>({
    pluginRoot,
    pluginId,
    origin,
    artifactBasename: "api.js",
  });
}

function loadFacade(dirName: string, artifactBasename = "runtime-api.js") {
  return loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>({
    dirName,
    artifactBasename,
  });
}

function withRequest<T>(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  run: () => T,
  pluginId?: string,
) {
  return withPluginRuntimeGatewayRequestScope(
    { pluginRegistry, pluginId, isWebchatConnect: () => false },
    run,
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const disposals = await Promise.allSettled(
    records.splice(0).map(async (record) => await getPluginInstance(record)?.dispose()),
  );
  const cleanups = await Promise.allSettled(
    [resetPluginRuntimeStateForTest, resetFacadeLoaderStateForTest, temp.cleanup].map(
      async (cleanup) => cleanup(),
    ),
  );
  const failures = [...disposals, ...cleanups].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Plugin fixture cleanup failed");
  }
});

function writeSource(root: string, version: string, extension: "ts" | "js" = "ts", size = 1) {
  const annotation = extension === "ts" ? ": string" : "";
  write(root, "package.json", '{"type":"module"}');
  write(
    root,
    `state.${extension}`,
    `let value = ${JSON.stringify(version)};
    export const read = () => value;
    export const set = (next${annotation}) => { value = next; };
    export const view = { read, frozen: Object.freeze(Array.from({ length: ${size} }, () => read)) };`,
  );
  write(
    root,
    `index.${extension}`,
    `import { set } from "./state.js";
    export default { register(value${annotation}) { set(value); } };`,
  );
  for (const entry of ["api", "runtime-api"]) {
    write(root, `${entry}.${extension}`, 'export { read, view } from "./state.js";');
  }
}

function prepare(
  rootDir: string,
  pluginId = "surface-fixture",
  origin: "global" | "bundled" = "global",
  extension: "ts" | "mts" | "js" = "ts",
  entryDirectory = ".",
) {
  const cache = createPluginCache();
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: pluginId,
    rootDir,
    source: path.join(rootDir, entryDirectory, `index.${extension}`),
    origin,
  });
  registry.plugins.push(record);
  records.push(record);
  const load = withPluginCache(cache, () =>
    createPluginModuleLoader({ tryNative: extension === "js", installNativeSdkResolver: false }),
  );
  const entry = load(record.source, { record, rootDir, registry }) as {
    default: { register: (value: string) => void };
  };
  const instance = expectDefined(getPluginInstance(record), "captured plugin instance");
  return {
    root: rootDir,
    registry,
    record,
    instance,
    entry,
    publish: () => {
      adoptProcessPluginCache(cache);
      stageActivePluginRegistry(registry, pluginId, "default");
    },
  };
}

function register(fixture: ReturnType<typeof prepare>, value: string) {
  fixture.entry.default.register(value);
  fixture.publish();
  return fixture;
}

function sourceFixture(version: string, pluginId?: string) {
  const root = makeRoot();
  writeSource(root, version);
  return prepare(root, pluginId);
}

describe("managed plugin public surfaces", () => {
  it("keeps a prepared source overlay's setup web provider under a merged environment", async () => {
    const parent = temp.make("openclaw-web-provider-overlay-");
    const pluginId = "overlay-web-provider";
    const bundledDir = path.join(parent, "stock");
    const stock = path.join(bundledDir, pluginId);
    const overlay = path.join(parent, "overlay", pluginId);
    writeSource(stock, "packaged-peer", "js");
    writeSource(overlay, "source");
    const providerModule = `
      import { read } from "./state.js";
      export const createFixtureWebSearchProvider = () => ({
        id: ${JSON.stringify(pluginId)}, label: read(), hint: "", envVars: [],
        placeholder: "", signupUrl: "", credentialPath: "apiKey",
        getCredentialValue: read, setCredentialValue() {}, createTool() { return null; },
      });
    `;
    write(stock, "web-search-contract-api.js", providerModule);
    write(overlay, "web-search-contract-api.ts", providerModule);
    const active = register(prepare(overlay, pluginId, "bundled"), "registered-overlay");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
    // Secret refresh copies env while retaining the selected manifest and live source generation.
    const env = { ...process.env };
    const providers = resolvePluginWebSearchProviders({
      env,
      mode: "setup",
      onlyPluginIds: [pluginId],
      config: { plugins: { allow: [pluginId] } },
      manifestRecords: [
        createPluginManifestRecordFixture({
          id: pluginId,
          rootDir: overlay,
          source: active.record.source,
          sourcePreferred: true,
          contracts: { webSearchProviders: [pluginId] },
        }),
      ],
    });
    expect(providers.map((provider) => provider.label)).toEqual(["registered-overlay"]);
    const provider = expectDefined(providers[0], "retained overlay web provider");
    expect(provider.getCredentialValue()).toBe("registered-overlay");
    await active.instance.dispose();
    expect(provider.getCredentialValue()).toBe("registered-overlay");
  });

  it.each(["id", "folder", "channel"] as const)(
    "selects the unique loaded %s owner before considering lower-priority aliases",
    (tier) => {
      const parent = makeRoot();
      const dirName = "runtime-selected";
      const prepareOwner = (name: string, folder: string, id: string) => {
        const root = path.join(parent, name, folder);
        writeSource(root, name, "js");
        const active = prepare(root, id, "global", "js");
        active.record.channelIds.push(dirName);
        return active;
      };
      const winner = prepareOwner(
        "winner",
        tier === "folder" ? dirName : "winner-root",
        tier === "id" ? dirName : "winner",
      );
      const first = prepareOwner(
        "first",
        tier === "id" || tier === "channel" ? dirName : "first-root",
        tier === "channel" ? dirName : "first",
      );
      const second = prepareOwner("second", tier === "id" ? dirName : "second-root", "second");
      if (tier === "channel") {
        first.record.status = "disabled";
        second.record.status = "disabled";
      }
      winner.registry.plugins.unshift(first.record, second.record);
      winner.publish();
      const load = () => loadFacade(dirName, "api.js");
      expect(load().read()).toBe("winner");

      winner.registry.plugins.push(
        createPluginRecord({
          ...winner.record,
          rootDir: path.join(parent, "duplicate", path.basename(winner.record.rootDir!)),
        }),
      );
      expect(load).toThrow(/ambiguous runtime ownership/);
    },
  );

  it("resolves installed native filesystem dist APIs without losing their managed owner", () => {
    const hooks = Reflect.get(Module, "registerHooks");
    Reflect.set(Module, "registerHooks", undefined);
    try {
      const root = makeRoot();
      writeSource(root, "library");
      fs.rmSync(path.join(root, "api.ts"));
      fs.rmSync(path.join(root, "runtime-api.ts"));
      write(root, "dist/api.js", 'export { read } from "../state.js";');
      const active = register(prepare(root, "native-dist-fixture"), "registered");
      const api = loadApi(root, undefined, "global");
      expect(api.read()).toBe("registered");
      expect(getPluginValueInstance(api)).toBe(active.instance);
    } finally {
      Reflect.set(Module, "registerHooks", hooks);
    }
  });

  it("shares installed registration state with captured APIs, refreshes a retained facade, and fences old exports", async () => {
    const first = register(sourceFixture("source-one"), "registered-one");
    const { root } = first;
    const load = () => loadApi(root);
    const facade = () => loadFacade(first.record.id);
    const lazy = createLazyFacadeObjectValue(() => facade().view);
    const frozen = createLazyFacadeObjectValue(() => facade().view.frozen);

    // Neither public entry has executed yet. The captured graph survives source deletion.
    fs.rmSync(path.join(root, "api.ts"));
    fs.rmSync(path.join(root, "runtime-api.ts"));
    write(root, "state.ts", 'export const read = () => "uncommitted edit";');
    const originalApi = load();
    const originalRead = originalApi.read;
    expect([originalRead(), facade().read(), lazy.read()]).toEqual(Array(3).fill("registered-one"));
    const retainedLazyRead = lazy.read;
    for (const [property, descriptor] of [
      ["read", { configurable: false, writable: false }],
      ["added", { value: "fixed" }],
      [Symbol("fixed"), { get: () => "fixed", configurable: false }],
    ] as const) {
      const before = Object.getOwnPropertyDescriptor(originalApi.view, property);
      expect(Reflect.defineProperty(lazy, property, descriptor)).toBe(false);
      expect(Object.getOwnPropertyDescriptor(originalApi.view, property)).toEqual(before);
    }
    expect(Reflect.set(lazy, "note", "first")).toBe(true);
    expect(Reflect.defineProperty(lazy, "note", { value: "updated" })).toBe(true);
    expect(Reflect.get(originalApi.view, "note")).toBe("updated");
    const configurable = Symbol("configurable");
    expect(
      Reflect.defineProperty(lazy, configurable, { value: "allowed", configurable: true }),
    ).toBe(true);
    expect(Reflect.get(originalApi.view, configurable)).toBe("allowed");
    expect(Object.getOwnPropertyDescriptor(frozen, "length")).toMatchObject({
      value: 1,
      configurable: true,
    });
    expect(Object.keys(frozen)).toEqual(["0"]);
    for (const operation of ["preventExtensions", "seal", "freeze"] as const) {
      const applyIntegrity: (value: object) => object = Object[operation];
      expect(() => applyIntegrity(lazy)).toThrow(TypeError);
      expect(Object.isExtensible(lazy)).toBe(true);
      expect(lazy.read()).toBe("registered-one");
    }
    const probes = [
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "realpathSync"),
      vi.spyOn(fs, "statSync"),
      vi.spyOn(fs, "openSync"),
    ];
    expect(load()).toBe(originalApi);
    expect(lazy.read()).toBe("registered-one");
    for (const probe of probes) {
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    }

    await first.instance.dispose();
    writeSource(root, "source-two", "ts", 2);
    const second = register(prepare(root), "registered-two");
    expect([load().read(), lazy.read(), frozen[1]?.()]).toEqual(Array(3).fill("registered-two"));
    expect(frozen).toHaveLength(2);
    expect(Object.keys(frozen)).toEqual(["0", "1"]);
    expect(originalRead).toThrow(/reloaded|disabled|retiring/);
    expect(retainedLazyRead).toThrow(/reloaded|disabled|retiring/);
    expect(() => withRequest(first.registry, load)).toThrow(MissingPublicSurfaceError);

    const retained = load();
    const nextRegistry = createEmptyPluginRegistry();
    nextRegistry.plugins.push(second.record);
    stageActivePluginRegistry(nextRegistry, "unrelated-change", "default");
    expect(load()).toBe(retained);
    expect(lazy.read()).toBe("registered-two");
  });

  it.each(["relative", "tsconfig"] as const)(
    "loads captured dependencies and %s source mappings after originals are removed",
    (mapping) => {
      const parent = makeRoot();
      const root = path.join(parent, "plugin");
      writeSource(root, "source");
      const dependency = path.join(root, "node_modules", "captured-dependency");
      write(dependency, "package.json", '{"main":"index.cjs"}');
      write(dependency, "index.cjs", 'exports.value = "dependency";');
      write(
        root,
        "package.json",
        '{"type":"module","dependencies":{"captured-dependency":"1.0.0"}}',
      );
      if (mapping === "tsconfig") {
        vi.stubEnv("JITI_TSCONFIG_PATHS", "true");
        // Jiti configuration remains available; only captured plugin code is removed.
        write(
          parent,
          "tsconfig.json",
          JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: { "@fixture/state": ["./plugin/state.ts"] } },
          }),
        );
      }
      write(
        root,
        "api.ts",
        `
        import { read as readState } from ${JSON.stringify(mapping === "tsconfig" ? "@fixture/state" : "./state.js")};
        import { value } from "captured-dependency";
        export const read = () => readState() + ":" + value;
      `,
      );
      register(prepare(root), "registered");
      fs.rmSync(root, { recursive: true });
      expect(loadApi(root).read()).toBe("registered:dependency");
    },
  );

  it("requires exact identity when package siblings have separate module instances", () => {
    const first = sourceFixture("source", "first");
    const { root } = first;
    const second = prepare(root, "second");
    first.entry.default.register("first-instance");
    second.entry.default.register("second-instance");
    second.registry.plugins.unshift(first.record);
    second.publish();
    const load = (pluginId?: string) => loadApi(root, pluginId);
    expect(() => load()).toThrow(/ambiguous runtime ownership/);
    expect([
      load("first").read(),
      load("second").read(),
      withRequest(second.registry, () => load().read(), "first"),
    ]).toEqual(["first-instance", "second-instance", "first-instance"]);
  });

  it.each([
    ["ts", ".", "."],
    ["ts", "dist", "."],
    ["mts", ".", "."],
    ["js", ".", "."],
    ["js", "dist", "."],
    ["js", "dist", "dist"],
    ["ts", "dist", "src"],
  ] as const)(
    "keeps public APIs on the registered %s graph when source and build coexist in %s (entry in %s)",
    (extension, buildDirectory, entryDirectory) => {
      const root = makeRoot();
      const buildRoot = path.join(root, buildDirectory);
      writeSource(buildRoot, "stale-build", "js");
      writeSource(root, "source");
      if (extension === "mts") {
        fs.renameSync(path.join(root, "index.ts"), path.join(root, "index.mts"));
      }
      if (extension === "js" && buildDirectory === "dist" && entryDirectory === ".") {
        write(root, "index.js", 'export { default } from "./dist/index.js";');
      }
      if (entryDirectory === "src") {
        write(
          root,
          "src/index.ts",
          'import { set } from "../state.js"; export default { register(value: string) { set(value); } };',
        );
      }
      const active = register(
        prepare(root, "surface-fixture", "global", extension, entryDirectory),
        "registered-graph",
      );

      // Resolve both previously unexecuted APIs from the captured inventory.
      fs.rmSync(root, { recursive: true });
      const api = loadApi(root);
      const runtime = loadFacade(active.record.id);
      expect([api.read(), runtime.read()]).toEqual(["registered-graph", "registered-graph"]);
      expect(runtime.view).toBe(api.view);
    },
  );

  it.each(["disabled", "uninstalled"] as const)(
    "does not reload a %s plugin through a retained facade or runtime request",
    async (state) => {
      const active = sourceFixture("active");
      const { root } = active;
      active.publish();
      const load = () => loadApi(root);
      const lazy = createLazyFacadeObjectValue(() => load().view);
      expect(lazy.read()).toBe("active");
      const registry = createEmptyPluginRegistry();
      if (state === "disabled") {
        registry.plugins.push(
          createPluginRecord({
            id: active.record.id,
            rootDir: root,
            source: active.record.source,
            enabled: false,
            status: "disabled",
          }),
        );
      }
      stageActivePluginRegistry(registry, state, "gateway-bindable");
      await active.instance.dispose();
      // Keep the package installed, as disable and uninstall --keep-files do.
      writeSource(root, "must-not-execute");
      expect(() => lazy.read()).toThrow(/disabled or uninstalled/);
      expect(() => withRequest(registry, load)).toThrow(/no active runtime owner/);
    },
  );

  it("resolves captured public entries through the original root and its canonical alias", () => {
    const directory = makeRoot();
    const root = path.join(directory, "source");
    const alias = path.join(directory, "linked");
    writeSource(root, "captured");
    fs.symlinkSync(root, alias, "junction");
    const active = prepare(alias);
    active.publish();
    fs.rmSync(path.join(root, "api.ts"));
    for (const pluginRoot of [root, alias]) {
      expect(loadApi(pluginRoot).read()).toBe("captured");
    }
  });

  it.each([
    ["ts", "sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
    ["ts", "async", loadActivatedBundledPluginPublicSurfaceModule],
    ["js", "sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
    ["js", "async", loadActivatedBundledPluginPublicSurfaceModule],
  ] as const)(
    "keeps %s bundled inspection libraries usable while fencing %s activated runtime exports",
    async (extension, _mode, loadActivated) => {
      const directory = makeRoot();
      const pluginId = "bundled-surface-fixture";
      const root = path.join(directory, pluginId);
      writeSource(root, "library", extension);
      write(root, "openclaw.plugin.json", JSON.stringify({ id: pluginId }));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", directory);
      const request = { dirName: pluginId, artifactBasename: "api.js" };
      expect(
        withRequest(createEmptyPluginRegistry(), () =>
          loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request).read(),
        ),
      ).toBe("library");
      const active = register(prepare(root, pluginId, "bundled", extension), "registered");
      stageActivePluginRegistry(active.registry, "bundled", "gateway-bindable");
      facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(
        await import("../plugin-sdk/facade-activation-check.runtime.js"),
      );
      const library = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request);
      const runtime = await loadActivated<PublicApi>(request);
      const retainedRead = runtime.read;
      expect([library.read(), runtime.read()]).toEqual(["registered", "registered"]);
      const disabled = createEmptyPluginRegistry();
      disabled.plugins.push(
        createPluginRecord({ ...active.record, enabled: false, status: "disabled" }),
      );
      stageActivePluginRegistry(disabled, "disabled", "gateway-bindable");
      await active.instance.dispose();
      const inspection = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request);
      expect(inspection).toBe(library);
      expect(library.read()).toBe("registered");
      expect(retainedRead).toThrow(/reloaded|disabled|retiring/);
      expect(() => runtime.read()).toThrow(/reloaded or disabled/);
      await expect(async () => await loadActivated(request)).rejects.toThrow(/access blocked/);
    },
  );
});
