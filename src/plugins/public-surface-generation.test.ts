import fs from "node:fs";
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
import { writeArtifact, writeArtifacts } from "./public-surface.test-support.js";
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
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const disposals = await Promise.allSettled(
    records.splice(0).map(async (record) => await getPluginInstance(record)?.dispose()),
  );
  const failures: unknown[] = disposals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const cleanup of [
    resetPluginRuntimeStateForTest,
    resetFacadeLoaderStateForTest,
    temp.cleanup,
  ]) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Plugin fixture cleanup failed");
  }
});

function writeSource(root: string, version: string, extension: "ts" | "js" = "ts", size = 1) {
  const annotation = extension === "ts" ? ": string" : "";
  writeArtifacts(root, {
    "package.json": { type: "module" },
    [`state.${extension}`]: `let value = ${JSON.stringify(version)};
    export const read = () => value;
    export const set = (next${annotation}) => { value = next; };
    export const view = { read, frozen: Object.freeze(Array.from({ length: ${size} }, () => read)) };`,
    [`index.${extension}`]: `import { set } from "./state.js";
    export default { register(value${annotation}) { set(value); } };`,
    [`api.${extension}`]: 'export { read, view } from "./state.js";',
    [`runtime-api.${extension}`]: 'export { read, view } from "./state.js";',
  });
}

function write(root: string, name: string, contents: string) {
  return writeArtifact(path.join(root, name), contents);
}
function loadApi(pluginRoot: string) {
  return loadPluginPublicArtifactModuleSync<PublicApi>({
    pluginRoot,
    artifactBasename: "api.js",
  });
}
function loadFacade(dirName: string, artifactBasename = "runtime-api.js") {
  return loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>({ dirName, artifactBasename });
}
function inRequest<T>(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  run: () => T,
  pluginId?: string,
) {
  return withPluginRuntimeGatewayRequestScope(
    { pluginRegistry, pluginId, isWebchatConnect: () => false },
    run,
  );
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
    registry,
    record,
    instance,
    entry,
    publish: (value?: string) => {
      if (value !== undefined) {
        entry.default.register(value);
      }
      adoptProcessPluginCache(cache);
      stageActivePluginRegistry(registry, pluginId, "default");
    },
  };
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
    const active = prepare(overlay, pluginId, "bundled");
    active.publish("registered-overlay");
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
      const parent = fs.realpathSync(temp.make("openclaw-public-owner-priority-"));
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
    const root = fs.realpathSync(temp.make("openclaw-native-public-dist-"));
    writeSource(root, "library");
    fs.rmSync(path.join(root, "api.ts"));
    fs.rmSync(path.join(root, "runtime-api.ts"));
    write(root, "dist/api.js", 'export { read } from "../state.js";');
    const active = prepare(root, "native-dist-fixture");
    active.publish("registered");
    const api = loadPluginPublicArtifactModuleSync<{ read(): string }>({
      pluginRoot: root,
      artifactBasename: "api.js",
      origin: "global",
    });
    expect(api.read()).toBe("registered");
    expect(getPluginValueInstance(api)).toBe(active.instance);
  });

  it("shares installed registration state with captured APIs, refreshes a retained facade, and fences old exports", async () => {
    const root = fs.realpathSync(temp.make("openclaw-public-generation-"));
    writeSource(root, "source-one");
    const first = prepare(root);
    first.publish("registered-one");
    const api = () => loadApi(root);
    const facade = () => loadFacade(first.record.id);
    const lazy = createLazyFacadeObjectValue(() => facade().view);
    const frozen = createLazyFacadeObjectValue(() => facade().view.frozen);

    // Neither public entry has executed yet. The captured graph survives source deletion.
    fs.rmSync(path.join(root, "api.ts"));
    fs.rmSync(path.join(root, "runtime-api.ts"));
    fs.writeFileSync(path.join(root, "state.ts"), 'export const read = () => "uncommitted edit";');
    const originalApi = api();
    const originalRead = originalApi.read;
    expect(originalRead()).toBe("registered-one");
    expect(facade().read()).toBe("registered-one");
    expect(lazy.read()).toBe("registered-one");
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
    expect(api()).toBe(originalApi);
    expect(lazy.read()).toBe("registered-one");
    for (const probe of probes) {
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    }

    await first.instance.dispose();
    writeSource(root, "source-two", "ts", 2);
    const second = prepare(root);
    second.publish("registered-two");
    expect(api().read()).toBe("registered-two");
    expect(lazy.read()).toBe("registered-two");
    expect(frozen.length).toBe(2);
    expect(Object.keys(frozen)).toEqual(["0", "1"]);
    expect(frozen[1]?.()).toBe("registered-two");
    expect(originalRead).toThrow(/reloaded|disabled|retiring/);
    expect(retainedLazyRead).toThrow(/reloaded|disabled|retiring/);
    expect(() => inRequest(first.registry, api)).toThrow(MissingPublicSurfaceError);

    const retained = api();
    const nextRegistry = createEmptyPluginRegistry();
    nextRegistry.plugins.push(second.record);
    stageActivePluginRegistry(nextRegistry, "unrelated-change", "default");
    expect(api()).toBe(retained);
    expect(lazy.read()).toBe("registered-two");
  });

  it.each(["relative", "tsconfig"] as const)(
    "loads captured dependencies and %s source mappings after originals are removed",
    (mapping) => {
      const parent = fs.realpathSync(temp.make("openclaw-public-dependencies-"));
      const root = path.join(parent, "plugin");
      writeSource(root, "source");
      const dependency = path.join(root, "node_modules", "captured-dependency");
      writeArtifacts(dependency, {
        "package.json": { main: "index.cjs" },
        "index.cjs": 'exports.value = "dependency";',
      });
      writeArtifacts(root, {
        "package.json": { type: "module", dependencies: { "captured-dependency": "1.0.0" } },
      });
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
      const active = prepare(root);
      active.publish("registered");
      fs.rmSync(root, { recursive: true });
      const api = loadApi(root);
      expect(api.read()).toBe("registered:dependency");
    },
  );

  it("requires exact identity when package siblings have separate module instances", () => {
    const root = fs.realpathSync(temp.make("openclaw-public-cohort-"));
    writeSource(root, "source");
    const first = prepare(root, "first");
    const second = prepare(root, "second");
    first.entry.default.register("first-instance");
    second.entry.default.register("second-instance");
    second.registry.plugins.unshift(first.record);
    second.publish();
    const load = () => loadApi(root);
    expect(() => load()).toThrow(/ambiguous runtime ownership/);
    expect(inRequest(second.registry, () => load().read(), "first")).toBe("first-instance");
    expect(inRequest(second.registry, () => load().read(), "second")).toBe("second-instance");
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
      const root = fs.realpathSync(temp.make("openclaw-public-mixed-source-"));
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
      const active = prepare(root, "surface-fixture", "global", extension, entryDirectory);
      active.publish("registered-graph");

      // Resolve both previously unexecuted APIs from the captured inventory.
      fs.rmSync(root, { recursive: true });
      const api = loadApi(root);
      const runtime = loadFacade(active.record.id);
      expect(api.read()).toBe("registered-graph");
      expect(runtime.read()).toBe("registered-graph");
      expect(runtime.view).toBe(api.view);
    },
  );

  it.each(["disabled", "uninstalled"] as const)(
    "does not reload a %s plugin through a retained facade or runtime request",
    async (state) => {
      const root = fs.realpathSync(temp.make("openclaw-public-disabled-"));
      writeSource(root, "active");
      const active = prepare(root);
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
      expect(() => inRequest(registry, load)).toThrow(/no active runtime owner/);
    },
  );

  it("resolves captured public entries through the original root and its canonical alias", () => {
    const directory = fs.realpathSync(temp.make("openclaw-public-alias-"));
    const root = path.join(directory, "source");
    const alias = path.join(directory, "linked");
    fs.mkdirSync(root);
    fs.symlinkSync(root, alias, "junction");
    writeSource(root, "captured");
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
      const directory = fs.realpathSync(temp.make("openclaw-public-bundled-"));
      const pluginId = "bundled-surface-fixture";
      const root = path.join(directory, pluginId);
      writeSource(root, "library", extension);
      fs.writeFileSync(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: pluginId }));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", directory);
      const request = { dirName: pluginId, artifactBasename: "api.js" };
      expect(
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
          () => loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request).read(),
        ),
      ).toBe("library");
      const active = prepare(root, pluginId, "bundled", extension);
      active.publish("registered");
      stageActivePluginRegistry(active.registry, "bundled", "gateway-bindable");
      facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(
        await import("../plugin-sdk/facade-activation-check.runtime.js"),
      );
      const library = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request);
      const runtime = await loadActivated<PublicApi>(request);
      const retainedRead = runtime.read;
      expect(library.read()).toBe("registered");
      expect(runtime.read()).toBe("registered");
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
