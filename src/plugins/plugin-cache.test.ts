import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { isPathInside, openPluginRootFileSync } from "./path-safety.js";
import {
  checkPluginCacheEntry,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  pluginCacheLstatSync,
  readPluginCacheDirectory,
  refreshPluginCacheStat,
  readPluginCacheFile,
  readPluginCacheJsonFile,
} from "./plugin-cache-files.js";
import {
  createPluginCache,
  getPluginCacheRoot,
  getPluginCacheSource,
  getProcessPluginCache,
  invalidatePluginCacheMetadata,
  retainPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getPluginLoaderCacheState,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readFile(
  rootDir: string,
  relativePath: string,
  rejectHardlinks = true,
  maxBytes?: number | null,
) {
  return readPluginCacheFile({ rootDir, relativePath, rejectHardlinks, maxBytes });
}

function writeJson(dir: string, name: string, value: object) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function symlinkDir(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}

function fixture(files: Record<string, string> = {}, aliases: Record<string, string> = {}) {
  const root = fs.realpathSync(tempDirs.make("plugin-cache-"));
  const file = (name: string) => path.join(root, name);
  writeArtifacts(root, files);
  for (const [name, target] of Object.entries(aliases)) {
    if (fs.statSync(file(target)).isDirectory()) {
      symlinkDir(file(target), file(name));
    } else {
      fs.symlinkSync(file(target), file(name));
    }
  }
  return { root, file };
}

function installedFixture(id: string) {
  const { file } = fixture({
    [`bundled/${id}/index.js`]: 'throw new Error("metadata must not execute code");',
  });
  const root = file(`bundled/${id}`);
  const write = (version?: string) => {
    const metadata = {
      manifest: JSON.stringify({ id, version, configSchema: { type: "object" } }),
      packageJson: JSON.stringify({
        name: `@fixture/${id}`,
        version,
        openclaw: { extensions: ["./index.js"] },
      }),
    };
    fs.writeFileSync(path.join(root, "openclaw.plugin.json"), metadata.manifest);
    fs.writeFileSync(path.join(root, "package.json"), metadata.packageJson);
    return metadata;
  };
  const env = {
    OPENCLAW_HOME: file("home"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: file("bundled"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { file, root, write, env };
}

function callsFor(calls: unknown[][], ...paths: string[]) {
  return calls.filter(([target]) => paths.includes(String(target)));
}

function checkEntry(rootDir: string, relativePath: string, rootRealPath?: string) {
  return checkPluginCacheEntry({ rootDir, relativePath, rootRealPath, rejectHardlinks: true });
}

it.each(["success", "plugin failure", "module failure", "host failure"] as const)(
  "retains adopted instance custody through disposal (%s)",
  async (outcome) => {
    const originalCache = createPluginCache();
    const successorCache = createPluginCache();
    const record = createPluginRecord({ id: "cache-custody" });
    const original = createEmptyPluginRegistry();
    original.plugins.push(record);
    const successor = { ...createEmptyPluginRegistry(), plugins: [record] };
    const instance = new PluginInstance(record.id, { record, registry: original });
    const callback = instance.wrap(() => "adopted");
    markPluginRegistryActive(original);
    getPluginLoaderCacheState(originalCache).set("original", original);
    markPluginRegistryActive(successor);
    getPluginLoaderCacheState(successorCache).set("successor", successor);

    await retirePluginCache(originalCache);
    expect(originalCache.instances.size).toBe(0);
    expect(callback()).toBe("adopted");
    expect(successorCache.instances.has(instance)).toBe(true);

    const failure = new Error(outcome);
    const fail = () => {
      throw failure;
    };
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    if (outcome === "plugin failure") {
      instance.lifecycle.onDispose(fail);
    }
    instance.onModuleDispose(async () => {
      entered.resolve();
      await finish.promise;
      if (outcome === "module failure") {
        fail();
      }
    });
    markPluginRegistryRetired(successor);
    const disposal = instance.dispose(outcome === "host failure" ? fail : undefined);
    void disposal.catch(() => {});
    try {
      await entered.promise;
      expect(successorCache.instances.has(instance)).toBe(true);
      finish.resolve();
      if (outcome === "host failure") {
        await expect(disposal).rejects.toBe(failure);
      } else {
        await expect(disposal).resolves.toEqual({
          errors: outcome === "success" ? [] : [failure],
        });
      }
      expect(successorCache.instances.has(instance)).toBe(outcome !== "success");
    } finally {
      finish.resolve();
      await Promise.allSettled([disposal, retirePluginCache(successorCache)]);
    }
  },
);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

function createWindowsRootAliasFixture(relativePath = "plugin.js") {
  const { root: parent, file } = fixture(
    { [`canonical-root/${relativePath}`]: "export default {};\n" },
    { "root-alias": "canonical-root" },
  );
  const root = file("canonical-root");
  const alias = file("root-alias");
  const source = path.join(root, relativePath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  return { parent, root, alias, source };
}

function createRetargetedWindowsRootFixture(basename: string) {
  const { file } = fixture(
    {
      [`trusted/plugin/${basename}`]: "trusted\n",
      [`replacement/plugin/${basename}`]: "replacement\n",
    },
    { "trusted-alias": "trusted/plugin", "observed-parent": "trusted" },
  );
  const observedParent = file("observed-parent");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  const observedRoot = file("observed-parent/plugin");
  const originalRealpath = fs.realpathSync;
  vi.spyOn(fs, "realpathSync").mockImplementation(((filePath, options) => {
    if (filePath === observedRoot) {
      fs.unlinkSync(observedParent);
      symlinkDir(file("replacement"), observedParent);
    }
    return originalRealpath(filePath, options as never);
  }) as typeof fs.realpathSync);
  return {
    trustedAlias: file("trusted-alias"),
    observedPath: path.join(observedRoot, basename),
    openSync: vi.spyOn(fs, "openSync"),
  };
}

it.skipIf(process.platform === "win32")(
  "reuses checked entry canonical paths until metadata invalidation",
  () => {
    const { root, file } = fixture({ "index.js": "export default {};\n" });
    const source = file("index.js");
    const nativeRealpath = vi.spyOn(fs.realpathSync, "native");
    const cache = getProcessPluginCache();
    expect(checkEntry(root, "index.js")).toMatchObject({
      ok: true,
      path: source,
      exists: true,
    });
    nativeRealpath.mockClear();
    expect(pluginCacheRealpathSync(source)).toBe(source);
    expect(pluginCacheRealpathSync(source, true)).toBe(source);
    expect(nativeRealpath).not.toHaveBeenCalled();

    fs.unlinkSync(source);
    invalidatePluginCacheMetadata(cache);
    expect(pluginCacheRealpathSync(source, true)).toBeNull();
    expect(pluginCacheRealpathSync(source)).toBeNull();
  },
);

it.skipIf(process.platform === "win32")(
  "shares metadata ancestors without trusting them at the file-open boundary",
  () => {
    const names = Array.from({ length: 8 }, (_, i) => `assets/${i}.svg`);
    const { root, file } = fixture(Object.fromEntries(names.map((name) => [name, "<svg/>\n"])));
    const icons = file("assets");
    const sources = names.map(file);
    const firstSource = sources[0]!;
    const { root: outside } = fixture({ "0.svg": "outside\n" });
    const nativeRealpath = vi.spyOn(fs.realpathSync, "native");
    const realpath = vi.spyOn(fs, "realpathSync");
    const lstat = vi.spyOn(fs, "lstatSync");
    const cache = getProcessPluginCache();
    for (const source of sources) {
      expect(pluginCacheRealpathSync(source)).toBe(source);
      expect(pluginCacheRealpathSync(source)).toBe(source);
      expect(lstat.mock.calls.filter(([filePath]) => filePath === source)).toHaveLength(1);
    }
    expect(realpath.mock.calls.length + nativeRealpath.mock.calls.length).toBeLessThanOrEqual(1);

    fs.renameSync(icons, path.join(root, "previous-assets"));
    fs.symlinkSync(outside, icons, "dir");
    expect(pluginCacheRealpathSync(firstSource)).toBe(firstSource);
    expect(readFile(root, "assets/0.svg").ok).toBe(false);

    invalidatePluginCacheMetadata(cache);
    expect(pluginCacheRealpathSync(firstSource)).toBe(path.join(outside, "0.svg"));
  },
);

it("preserves JavaScript realpath identities for canonical paths, aliases, and traversal", () => {
  const { file } = fixture(
    { "catalog.json": "root", "package/catalog.json": "package", "package/nested/.keep": "" },
    { alias: "package/nested" },
  );
  const packageDir = file("package");
  const alias = file("alias");

  const paths = [
    packageDir,
    alias,
    `${alias}${path.sep}..${path.sep}catalog.json`,
    path.relative(process.cwd(), packageDir),
    ...(process.platform === "win32" ? [packageDir.toUpperCase()] : []),
  ];
  const nativeRealpath = vi.spyOn(fs.realpathSync, "native");
  for (const targetPath of paths) {
    const expected = fs.realpathSync(targetPath);
    const nativeExpected = fs.realpathSync.native(targetPath);
    for (const nativeFirst of [false, true]) {
      nativeRealpath.mockClear();
      const cache = createPluginCache();
      withPluginCache(cache, () => {
        if (nativeFirst) {
          expect(pluginCacheRealpathSync(targetPath, true)).toBe(nativeExpected);
        }
        expect(pluginCacheRealpathSync(targetPath)).toBe(expected);
        expect(pluginCacheRealpathSync(targetPath, true)).toBe(nativeExpected);
        expect(nativeRealpath).toHaveBeenCalledTimes(1);
        invalidatePluginCacheMetadata(cache);
        expect(pluginCacheRealpathSync(targetPath)).toBe(expected);
        expect(pluginCacheRealpathSync(targetPath, true)).toBe(nativeExpected);
        expect(nativeRealpath).toHaveBeenCalledTimes(2);
      });
    }
  }
});

it("retains JavaScript resolution when native resolution fails without merging cache policies", () => {
  const root = tempDirs.make("plugin-realpath-fallback-");
  const expected = fs.realpathSync(root);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
    throw Object.assign(new Error("native resolution unavailable"), { code: "ELOOP" });
  });
  expect(pluginCacheRealpathSync(root, true)).toBeNull();
  expect(pluginCacheRealpathSync(root)).toBe(expected);
  expect(pluginCacheRealpathSync(root, true)).toBeNull();
});

it("rejects a retargeted observed root during plugin cache entry check", () => {
  const { trustedAlias, observedPath, openSync } =
    createRetargetedWindowsRootFixture("package.json");
  const relativePath = path.relative(trustedAlias, observedPath);

  const result = checkEntry(trustedAlias, relativePath);

  expect(result).toMatchObject({
    ok: false,
    reason: "validation",
    error: { code: "path-mismatch" },
  });
  expect(openSync).not.toHaveBeenCalled();
});
it("reads an aliased Windows plugin root through the descriptor boundary", () => {
  const { parent, root, alias, source } = createWindowsRootAliasFixture("nested/plugin.js");
  const external = path.join(parent, "external.js");
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, path.join(root, "external-link.js"));
  expect(isPathInside(alias, source)).toBe(true);
  expect(isPathInside(alias, external)).toBe(false);
  const opened = openPluginRootFileSync({
    rootPath: alias,
    filePath: source,
    rejectHardlinks: false,
  });
  expect(opened.ok).toBe(true);
  if (opened.ok) {
    expect(opened.path).toBe(source);
    fs.closeSync(opened.fd);
  }

  // Mirror short-root/long-child records produced by Windows discovery.
  const file = readFile(alias, path.relative(alias, source), false);
  expect(file.ok && file.contents.toString("utf8")).toBe("export default {};\n");
  expect(readFile(alias, "external-link.js", false).ok).toBe(false);
});

it.each(["junction", "short root"] as const)("admits Windows entry alias: %s", (kind) => {
  const { root, alias } = createWindowsRootAliasFixture();
  const observed = kind === "junction" ? alias : root;
  const canonical = kind === "junction" ? root : alias;
  expect(checkEntry(observed, "plugin.js", canonical)).toMatchObject({ ok: true, exists: true });
});

it.each(["regular", "symlink"] as const)("reuses %s provider catalog sources", (kind) => {
  const { root: dir, file } = fixture(
    { [kind === "symlink" ? "catalog.js" : "provider-discovery.js"]: "export default {};\n" },
    kind === "symlink" ? { "provider-discovery.js": "catalog.js" } : {},
  );
  const providerDiscoverySource = file("provider-discovery.js");
  writeJson(dir, "openclaw.plugin.json", {
    id: "cached-provider",
    providers: ["cached-provider"],
    providerCatalogEntry: "./provider-discovery.js",
    configSchema: { type: "object" },
  });
  const realpathSpy = vi.spyOn(fs, "realpathSync");
  const lstatSpy = vi.spyOn(fs, "lstatSync");

  let firstReadCounts: number[] | undefined;
  for (let build = 0; build < 2; build += 1) {
    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      candidates: [
        {
          idHint: "cached-provider",
          rootDir: dir,
          source: path.join(dir, "index.js"),
          origin: "bundled",
        },
      ],
    });
    expect(registry.plugins[0]?.providerDiscoverySource).toBe(providerDiscoverySource);
    const readCounts = [realpathSpy, lstatSpy].map(
      (spy) => callsFor(spy.mock.calls, providerDiscoverySource).length,
    );
    firstReadCounts ??= readCounts;
    expect(readCounts).toEqual(firstReadCounts);
  }
});

it.each(["regular", "boundary"] as const)(
  "shares missing %s files across reader policies per owner",
  (firstPolicy) => {
    const { root, file } = fixture();
    const filePath = file("catalog.json");
    const readers = {
      regular: () => readPluginCacheJsonFile(filePath),
      boundary: () => readFile(root, "catalog.json"),
    };
    expect(readers[firstPolicy]().ok).toBe(false);
    fs.writeFileSync(filePath, "{}");
    expect(readers.regular().ok).toBe(false);
    expect(readers.boundary().ok).toBe(false);
    withPluginCache(createPluginCache(), () => {
      expect(readers.regular().ok).toBe(true);
      expect(readers.boundary().ok).toBe(true);
    });
    expect(readers[firstPolicy]().ok).toBe(false);
  },
);

it("preserves regular-file symlink checks and per-reader size limits", () => {
  const { root, file } = fixture({ "catalog.json": "{}" }, { "alias.json": "catalog.json" });
  const filePath = file("catalog.json");
  const alias = file("alias.json");
  expect(readFile(root, "catalog.json", false).ok).toBe(true);
  expect(readPluginCacheJsonFile(alias).ok).toBe(false);
  expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
  expect(readPluginCacheJsonFile(filePath).ok).toBe(true);
  expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
});

it.each([2, null])("reuses checked bytes after a %s-byte read", (maxBytes) => {
  const { root } = fixture({ "catalog.json": "{}" });
  const read = (limit: number | null) => readFile(root, "catalog.json", true, limit).ok;
  expect([read(1), read(maxBytes)]).toEqual([false, true]);
  const open = vi.spyOn(fs, "openSync");
  expect([read(2), read(null), read(1)]).toEqual([true, true, false]);
  expect(open).not.toHaveBeenCalled();
});

it("preserves uncapped bundle reads without weakening the default metadata limit", () => {
  const contents = " ".repeat(16 * 1024 * 1024 + 1);
  const { root } = fixture({ "catalog.json": contents });
  expect(readFile(root, "catalog.json").ok).toBe(false);
  const uncapped = readFile(root, "catalog.json", true, null);
  expect(uncapped.ok && uncapped.contents.length).toBe(contents.length);
  expect(readFile(root, "catalog.json").ok).toBe(false);
});

it("reuses checked package entries across separate workspace discovery views", () => {
  const { root, file, write } = installedFixture("shared-entry");
  write();
  const entry = path.join(root, "index.js");
  const discover = (workspace: string) =>
    discoverConfiguredPluginLoadPaths({
      loadPaths: [root],
      workspaceDir: file(workspace),
    });
  const first = discover("a");
  expect(first.candidates.map((candidate) => candidate.idHint)).toContain("shared-entry");
  const open = vi.spyOn(fs, "openSync");
  const second = discover("b");
  expect(second.candidates[0]).toMatchObject({
    source: first.candidates[0]?.source,
    workspaceDir: file("b"),
  });
  expect(callsFor(open.mock.calls, entry)).toEqual([]);
});
it("keeps missing bundle markers fixed until an explicit operation reads a new generation", () => {
  const { root, file } = fixture({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "fixture" }),
  });
  const load = () => loadBundleManifest({ rootDir: root, bundleFormat: "claude" });
  expect(detectBundleManifestFormat(root)).toBe("claude");
  const before = load();
  expect(before.ok && before.manifest.skills).toEqual([]);
  fs.mkdirSync(file("skills"));
  expect(load()).toEqual(before);
  const fresh = withPluginCache(createPluginCache(), load);
  expect(fresh.ok && fresh.manifest.skills).toContain("skills");
});

it("shares checked aliases without discarding artifacts resolved before the first file read", () => {
  const { file } = fixture({ "package/package.json": "{}" }, { alias: "package" });
  const root = file("package");
  const alias = file("alias");
  const aliasRecord = getPluginCacheRoot(alias);
  aliasRecord.artifacts.set("missing-surface", null);
  const first = readFile(alias, "package.json");
  const open = vi.spyOn(fs, "openSync");
  expect(readFile(root, "package.json")).toBe(first);
  expect(getPluginCacheRoot(root).artifacts.has("missing-surface")).toBe(true);
  expect(open).not.toHaveBeenCalled();
});

it("keeps checked source aliases authoritative within their explicit cache generation", () => {
  const { file } = fixture(
    { "package with spaces/api.cjs": "module.exports = {};\n" },
    { "alias with spaces": "package with spaces" },
  );
  const alias = file("alias with spaces");
  const aliasPath = file("alias with spaces/api.cjs");
  const owner = createPluginCache();
  const lexicalSource = getPluginCacheSource(aliasPath, owner);
  const prepared = withPluginCache(owner, () =>
    preparePluginModule({
      modulePath: aliasPath,
      boundaryRoot: alias,
      boundaryLabel: "plugin root",
      rejectHardlinks: true,
      surfaceLabel: "fixture public surface",
    }),
  );
  expect(prepared.source).not.toBe(lexicalSource);

  const foreign = createPluginCache();
  const foreignSource = getPluginCacheSource(aliasPath, foreign);
  withPluginCache(foreign, () => {
    expect(getPluginCacheSource(aliasPath)).toBe(foreignSource);
    for (const modulePath of [
      aliasPath,
      prepared.modulePath,
      path.relative(process.cwd(), aliasPath),
      pathToFileURL(aliasPath).href,
    ]) {
      expect(getPluginCacheSource(modulePath, owner)).toBe(prepared.source);
    }
  });
});

it("does not use a permissive hardlink read to satisfy a strict root policy", () => {
  const { root, file } = fixture({ "source.json": "{}" });
  fs.linkSync(file("source.json"), file("package.json"));
  expect(readFile(root, "package.json", false).ok).toBe(true);
  expect(readFile(root, "package.json").ok).toBe(false);
  expect(pluginCacheExistsSync(file("missing.json"))).toBe(false);
  fs.writeFileSync(file("missing.json"), "{}");
  expect(pluginCacheExistsSync(file("missing.json"))).toBe(false);
});
it.each(["missing", "empty"])(
  "caches package facts and %s artifact directories until refresh",
  (directory) => {
    const id = "generation-owner";
    const { root: pluginDir, write, env } = installedFixture(id);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const packagePath = path.join(pluginDir, "package.json");
    const distDir = path.join(pluginDir, "dist");
    if (directory === "empty") {
      fs.mkdirSync(distDir);
    }
    const first = write("1.0.0");
    const discovery = discoverOpenClawPlugins({ env, installRecords: {} });
    expect(discovery.candidates.find((candidate) => candidate.idHint === id)).toBeDefined();
    write("2.0.0");
    const open = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readFileSync");
    expect(discoverOpenClawPlugins({ env, installRecords: {} })).toBe(discovery);
    const registry = loadPluginManifestRegistryCore({ env, discovery, installRecords: {} });
    const exists = vi.spyOn(fs, "existsSync");
    const buildRecords = () =>
      buildInstalledPluginIndexRecords({
        candidates: discovery.candidates,
        registry,
        diagnostics: [],
        installRecords: {},
      });
    const records = buildRecords();
    expect(registry.plugins.find((plugin) => plugin.id === id)?.version).toBe("1.0.0");
    const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
    expect(records.find((record) => record.pluginId === id)).toMatchObject({
      manifestHash: hash(first.manifest),
      packageJson: { hash: hash(first.packageJson) },
    });
    expect(callsFor([...open.mock.calls, ...read.mock.calls], manifestPath, packagePath)).toEqual(
      [],
    );
    expect(
      exists.mock.calls.filter(([target]) => String(target).startsWith(`${distDir}${path.sep}`)),
    ).toEqual([]);
    expect(records[0]?.doctorContractHash).toBeUndefined();
    fs.mkdirSync(distDir, { recursive: true });
    const contract = "module.exports = {};";
    fs.writeFileSync(path.join(distDir, "doctor-contract-api.cjs"), contract);
    expect(buildRecords()[0]?.doctorContractHash).toBeUndefined();
    invalidatePluginCacheMetadata(getProcessPluginCache());
    expect(buildRecords()[0]?.doctorContractHash).toBe(hash(contract));
  },
);

it.each(["EACCES", "EPERM"])("resolves Doctor artifacts after %s listing failure", (code) => {
  const { root: rootDir, file } = fixture({
    "dist/doctor-contract-api.cjs": "module.exports = {};",
  });
  const modulePath = file("dist/doctor-contract-api.cjs");
  vi.spyOn(fs, "readdirSync").mockImplementation(() => {
    throw Object.assign(new Error("directory listing denied"), { code });
  });
  expect(resolvePluginDoctorContractArtifact({ rootDir, origin: "global" })).toEqual({
    modulePath,
    boundaryRoot: rootDir,
  });
});
it.each([false, true])("owns cleanup in closed request scopes (borrowed: %s)", async (borrowed) => {
  const requester = new AsyncWorkScope();
  const cache = createPluginCache();
  const instance = new PluginInstance("closed-cache-borrower");
  cache.instances.add(instance);
  const cleaned = vi.fn();
  instance.lifecycle.onDispose(() => trackAsyncWork(cleaned));
  const release = borrowed ? retainPluginCache(cache) : undefined;
  const run = requester.run(() => AsyncLocalStorage.snapshot());
  await requester.drain();
  try {
    const retirement = run(() => retirePluginCache(cache));
    void retirement.catch(() => {});
    run(() => release?.());
    await expect(retirement).resolves.toMatchObject({ failures: [] });
    expect(cleaned).toHaveBeenCalledOnce();
    await expect(requester.track(() => undefined)).rejects.toThrow("Async work scope is closed");
  } finally {
    release?.();
    await instance.dispose();
  }
});

it("retires a cache released by a borrower captured before package replacement", async () => {
  const requester = new AsyncWorkScope();
  const cache = createPluginCache();
  const instance = new PluginInstance("released-cache-borrower");
  cache.instances.add(instance);
  const cleaned = vi.fn();
  retainPluginCache(cache);
  const retainers = resolveGlobalSingleton(
    Symbol.for("openclaw.pluginCacheRetainers"),
    () =>
      new WeakMap<
        object,
        {
          references: Set<object>;
          settled: { resolve: () => void };
        }
      >(),
  );
  const retained = retainers.get(cache);
  assert(retained);
  const reference = retained.references.values().next().value;
  assert(reference);
  // v2026.9.5 release closures only publish this fact; their code survives replacement.
  const release = () => {
    if (retained.references.delete(reference) && retained.references.size === 0) {
      retained.settled.resolve();
    }
  };
  const finish = createDeferredCore();
  let cleaning = false;
  instance.lifecycle.onDispose(async () => {
    cleaning = true;
    await finish.promise;
    cleaned();
  });
  const { retirement } = await requester.track(() => ({ retirement: retirePluginCache(cache) }));
  void retirement.catch(() => {});
  await requester.drain();
  try {
    release();
    await nextTurn();
    expect(cleaning).toBe(true);
    expect(cleaned).not.toHaveBeenCalled();
    finish.resolve();
    await expect(retirement).resolves.toMatchObject({ failures: [] });
    expect(cleaned).toHaveBeenCalledOnce();
  } finally {
    release();
    finish.resolve();
    await retirement.catch(() => {});
  }
});

it("retains compact file facts across every metadata acquisition path", () => {
  const { root, file } = fixture(
    {
      "stat.json": "{}",
      "checked.json": "{}",
      "bounded.json": "{}",
      "regular.json": "{}",
      "folder/.keep": "",
    },
    { "alias.json": "stat.json" },
  );
  const cache = createPluginCache();
  withPluginCache(cache, () => {
    pluginCacheStatSync(file("stat.json"));
    pluginCacheLstatSync(file("alias.json"));
    checkEntry(root, "checked.json");
    readFile(root, "bounded.json");
    readPluginCacheJsonFile(file("regular.json"));
    const entries = readPluginCacheDirectory(root);
    expect(
      entries.map((entry) => [
        entry.name,
        entry.isFile(),
        entry.isDirectory(),
        entry.isSymbolicLink(),
      ]),
    ).toEqual(
      fs
        .readdirSync(root, { withFileTypes: true })
        .map((entry) => [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()]),
    );
    expect(entries.filter((entry) => entry instanceof fs.Dirent)).toHaveLength(0);
    for (const record of cache.roots.values()) {
      for (const [name, facts] of record.paths) {
        for (const kind of ["stat", "lstat"] as const) {
          const captured = facts[kind];
          if (!captured) {
            continue;
          }
          const actual =
            kind === "stat"
              ? fs.statSync(path.join(record.rootDir, name))
              : fs.lstatSync(path.join(record.rootDir, name));
          for (const key of ["mode", "uid", "nlink", "dev", "ino", "size", "mtimeMs"] as const) {
            expect(captured[key]).toBe(actual[key]);
          }
          expect([captured.isFile(), captured.isDirectory(), captured.isSymbolicLink()]).toEqual([
            actual.isFile(),
            actual.isDirectory(),
            actual.isSymbolicLink(),
          ]);
          expect(captured).not.toBeInstanceOf(fs.Stats);
        }
      }
    }
    fs.appendFileSync(file("stat.json"), "more");
    expect(pluginCacheStatSync(file("stat.json"))?.size).toBe(2);
    expect(refreshPluginCacheStat(file("stat.json"))?.size).toBe(6);
    fs.writeFileSync(file("new.json"), "{}");
    expect(readPluginCacheDirectory(root)).toBe(entries);
    invalidatePluginCacheMetadata(cache);
    expect(readPluginCacheDirectory(root).some((entry) => entry.name === "new.json")).toBe(true);
  });
});
