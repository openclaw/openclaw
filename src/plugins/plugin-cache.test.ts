import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { preparePluginModule } from "./plugin-module-loader-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

function createWindowsRootAliasFixture(
  prefix: string,
  relativePath = "plugin.js",
  contents = "export default {};\n",
) {
  const parent = fs.realpathSync(tempDirs.make(prefix));
  const root = path.join(parent, "canonical-root");
  const alias = path.join(parent, "root-alias");
  const source = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, contents);
  fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  return { parent, root, alias, source };
}

function createRetargetedWindowsRootFixture(prefix: string, basename: string) {
  const parent = fs.realpathSync(tempDirs.make(prefix));
  const trustedContainer = path.join(parent, "trusted");
  const replacementContainer = path.join(parent, "replacement");
  const trustedRoot = path.join(trustedContainer, "plugin");
  const replacementRoot = path.join(replacementContainer, "plugin");
  const trustedAlias = path.join(parent, "trusted-alias");
  const observedParent = path.join(parent, "observed-parent");
  fs.mkdirSync(trustedRoot, { recursive: true });
  fs.mkdirSync(replacementRoot, { recursive: true });
  fs.writeFileSync(path.join(trustedRoot, basename), "trusted\n");
  fs.writeFileSync(path.join(replacementRoot, basename), "replacement\n");
  fs.symlinkSync(trustedRoot, trustedAlias, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(
    trustedContainer,
    observedParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  const observedRoot = path.join(observedParent, "plugin");
  const originalLstat = fs.lstatSync;
  let rootObservations = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation(((filePath, options) => {
    if (filePath === observedRoot && ++rootObservations === 2) {
      fs.unlinkSync(observedParent);
      fs.symlinkSync(
        replacementContainer,
        observedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    return originalLstat(filePath, options as never);
  }) as typeof fs.lstatSync);
  return {
    trustedAlias,
    observedPath: path.join(observedRoot, basename),
    openSync: vi.spyOn(fs, "openSync"),
  };
}

describe("plugin package facts", () => {
  it("preserves JavaScript realpath identities for canonical paths, aliases, and traversal", () => {
    const root = fs.realpathSync(tempDirs.make("plugin-realpath-"));
    const packageDir = path.join(root, "package");
    const nestedDir = path.join(packageDir, "nested");
    const alias = path.join(root, "alias");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(root, "catalog.json"), "root");
    fs.writeFileSync(path.join(packageDir, "catalog.json"), "package");
    fs.symlinkSync(nestedDir, alias, process.platform === "win32" ? "junction" : "dir");

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
    withPluginCache(createPluginCache(), () => {
      expect(pluginCacheRealpathSync(root, true)).toBeNull();
      expect(pluginCacheRealpathSync(root)).toBe(expected);
      expect(pluginCacheRealpathSync(root, true)).toBeNull();
    });
  });

  it("proves aliased root containment by physical directory identity", () => {
    const { parent, alias, source } = createWindowsRootAliasFixture(
      "plugin-identity-containment-",
      path.join("nested", "plugin.js"),
    );
    const external = path.join(parent, "external.js");
    fs.writeFileSync(external, "export default {};\n");

    expect(isPathInside(alias, source)).toBe(true);
    expect(isPathInside(alias, external)).toBe(false);
  });

  it("opens a runtime entry when Windows reports the child through another root alias", () => {
    const { alias, source } = createWindowsRootAliasFixture("plugin-runtime-alias-open-");

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
  });

  it.each(["entry check", "file read"] as const)(
    "rejects a retargeted observed root during plugin cache %s",
    (operation) => {
      const { trustedAlias, observedPath, openSync } = createRetargetedWindowsRootFixture(
        "plugin-cache-alias-race-",
        "package.json",
      );
      const relativePath = path.relative(trustedAlias, observedPath);

      const result = withPluginCache(createPluginCache(), () =>
        operation === "entry check"
          ? checkPluginCacheEntry({
              rootDir: trustedAlias,
              relativePath,
              rejectHardlinks: true,
            })
          : readPluginCacheFile({
              rootDir: trustedAlias,
              relativePath,
              rejectHardlinks: true,
            }),
      );

      expect(result.ok).toBe(false);
      expect(openSync).not.toHaveBeenCalled();
    },
  );
  it("reads an aliased Windows plugin root through the descriptor boundary", () => {
    const { parent, root, alias, source } = createWindowsRootAliasFixture(
      "plugin-identity-read-",
      path.join("nested", "plugin.js"),
    );
    const external = path.join(parent, "external.js");
    fs.writeFileSync(external, "external\n");
    fs.symlinkSync(external, path.join(root, "external-link.js"));

    withPluginCache(createPluginCache(), () => {
      const file = readPluginCacheFile({
        rootDir: alias,
        // Mirror short-root/long-child records produced by Windows discovery.
        relativePath: path.relative(alias, source),
        rejectHardlinks: false,
      });
      expect(file.ok && file.contents.toString("utf8")).toBe("export default {};\n");
      expect(
        readPluginCacheFile({
          rootDir: alias,
          relativePath: "external-link.js",
          rejectHardlinks: false,
        }).ok,
      ).toBe(false);
    });
  });

  it("preserves a trusted Windows junction at the plugin root", () => {
    const { root, alias } = createWindowsRootAliasFixture("plugin-junction-root-");

    withPluginCache(createPluginCache(), () => {
      expect(
        checkPluginCacheEntry({
          rootDir: alias,
          rootRealPath: root,
          relativePath: "plugin.js",
          rejectHardlinks: true,
        }),
      ).toMatchObject({ ok: true, exists: true });
    });
  });

  it("reopens a long-spelled child beneath an admitted short Windows root", () => {
    const { root, alias } = createWindowsRootAliasFixture("plugin-short-root-entry-");

    withPluginCache(createPluginCache(), () => {
      expect(
        checkPluginCacheEntry({
          // Mirrors Windows discovery retaining the long child spelling while
          // native realpath preserves the trusted root's 8.3 alias.
          rootDir: root,
          rootRealPath: alias,
          relativePath: "plugin.js",
          rejectHardlinks: true,
        }),
      ).toMatchObject({ ok: true, exists: true });
    });
  });

  it.each(["native", "javascript"] as const)(
    "reuses the provider catalog source resolved by the %s filesystem path",
    (resolver) => {
      const dir = fs.realpathSync(tempDirs.make("plugin-provider-source-"));
      const providerDiscoverySource = path.join(dir, "provider-discovery.js");
      fs.writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "cached-provider",
          providers: ["cached-provider"],
          providerCatalogEntry: "./provider-discovery.js",
          configSchema: { type: "object" },
        }),
      );
      fs.writeFileSync(providerDiscoverySource, "export default {};\n", "utf8");
      const nativeRealpath = fs.realpathSync.native;
      const nativeRealpathSpy = vi.spyOn(fs.realpathSync, "native");
      if (resolver === "javascript") {
        nativeRealpathSpy.mockImplementation((filePath, options) => {
          // Exercise metadata fallback without disabling fs-safe's native
          // canonicalization when it admits the manifest descriptor.
          if (filePath === providerDiscoverySource) {
            throw new Error("native realpath unavailable");
          }
          return nativeRealpath(filePath, options);
        });
      }
      const realpathSpy = vi.spyOn(fs, "realpathSync");
      const resolverSpy = resolver === "native" ? nativeRealpathSpy : realpathSpy;

      withPluginCache(createPluginCache(), () => {
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
          expect(
            resolverSpy.mock.calls.filter(([filePath]) => filePath === providerDiscoverySource),
          ).toHaveLength(1);
        }
      });
    },
  );

  it("withPluginLifecycleLease refreshes enclosing operation facts while retaining its callbacks", async () => {
    const root = tempDirs.make("plugin-lease-parent-");
    const filePath = path.join(root, "catalog.json");
    fs.writeFileSync(filePath, '{"name":"before-install"}');
    await using cache = createPluginCache();
    const instance = new PluginInstance("setup-owner");
    cache.instances.add(instance);
    const afterWrite = instance.wrap(() => "post-write usable");
    await withPluginCache(cache, async () => {
      expect(readPluginCacheJsonFile(filePath)).toMatchObject({
        ok: true,
        value: { name: "before-install" },
      });
      await withPluginLifecycleLease({ path: path.join(root, "state.sqlite") }, async () => {
        fs.writeFileSync(filePath, '{"name":"after-install"}');
        clearPluginMetadataLifecycleCaches();
      });
      expect(readPluginCacheJsonFile(filePath)).toMatchObject({
        ok: true,
        value: { name: "after-install" },
      });
      expect(afterWrite()).toBe("post-write usable");
    });
  });

  it.each(["regular", "boundary"] as const)(
    "shares missing %s files across reader policies until the owner changes",
    (firstPolicy) => {
      const root = tempDirs.make("plugin-missing-policy-");
      const filePath = path.join(root, "catalog.json");
      const readers = {
        regular: () => readPluginCacheJsonFile(filePath),
        boundary: () =>
          readPluginCacheFile({
            rootDir: root,
            relativePath: "catalog.json",
            rejectHardlinks: true,
          }),
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
    const root = tempDirs.make("plugin-regular-policy-");
    const filePath = path.join(root, "catalog.json");
    const alias = path.join(root, "alias.json");
    fs.writeFileSync(filePath, "{}");
    fs.symlinkSync(filePath, alias);
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "catalog.json", rejectHardlinks: false })
        .ok,
    ).toBe(true);
    expect(readPluginCacheJsonFile(alias).ok).toBe(false);
    expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
    expect(readPluginCacheJsonFile(filePath).ok).toBe(true);
    expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
  });

  it.each([2, null])(
    "shares checked bytes across boundary size policies after a %s-byte read",
    (maxBytes) => {
      const root = tempDirs.make("plugin-boundary-size-policy-");
      fs.writeFileSync(path.join(root, "catalog.json"), "{}");
      const params = { rootDir: root, relativePath: "catalog.json", rejectHardlinks: true };
      expect(readPluginCacheFile({ ...params, maxBytes: 1 }).ok).toBe(false);
      expect(readPluginCacheFile({ ...params, maxBytes }).ok).toBe(true);
      const open = vi.spyOn(fs, "openSync");
      expect(readPluginCacheFile({ ...params, maxBytes: 2 }).ok).toBe(true);
      expect(readPluginCacheFile({ ...params, maxBytes: null }).ok).toBe(true);
      expect(readPluginCacheFile({ ...params, maxBytes: 1 }).ok).toBe(false);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("preserves uncapped bundle reads without weakening the default metadata limit", () => {
    const root = tempDirs.make("plugin-unbounded-policy-");
    const contents = Buffer.alloc(16 * 1024 * 1024 + 1, " ");
    fs.writeFileSync(path.join(root, "catalog.json"), contents);
    const params = { rootDir: root, relativePath: "catalog.json", rejectHardlinks: true };
    expect(readPluginCacheFile(params).ok).toBe(false);
    const uncapped = readPluginCacheFile({ ...params, maxBytes: null });
    expect(uncapped.ok && uncapped.contents.length).toBe(contents.length);
    expect(readPluginCacheFile(params).ok).toBe(false);
  });

  it("reuses checked package entries across separate workspace discovery views", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-workspace-entry-facts-"));
    const pluginDir = path.join(parent, "package");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@fixture/shared-entry",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "shared-entry",
        configSchema: { type: "object" },
      }),
    );
    const entry = path.join(pluginDir, "index.js");
    fs.writeFileSync(entry, 'throw new Error("metadata must not execute code");');
    const first = discoverConfiguredPluginLoadPaths({
      loadPaths: [pluginDir],
      workspaceDir: path.join(parent, "a"),
    });
    expect(first.candidates.map((candidate) => candidate.idHint)).toContain("shared-entry");
    const open = vi.spyOn(fs, "openSync");
    const second = discoverConfiguredPluginLoadPaths({
      loadPaths: [pluginDir],
      workspaceDir: path.join(parent, "b"),
    });
    expect(second.candidates[0]?.source).toBe(first.candidates[0]?.source);
    expect(second.candidates[0]?.workspaceDir).toBe(path.join(parent, "b"));
    expect(open.mock.calls.filter(([file]) => String(file) === entry)).toEqual([]);
  });
  it("keeps missing bundle markers fixed until an explicit operation reads a new generation", () => {
    const root = tempDirs.make("plugin-bundle-generation-");
    const metadataDir = path.join(root, ".claude-plugin");
    fs.mkdirSync(metadataDir);
    fs.writeFileSync(path.join(metadataDir, "plugin.json"), JSON.stringify({ name: "fixture" }));
    const format = detectBundleManifestFormat(root);
    expect(format).toBe("claude");
    const before = loadBundleManifest({ rootDir: root, bundleFormat: "claude" });
    expect(before.ok && before.manifest.skills).toEqual([]);
    fs.mkdirSync(path.join(root, "skills"));
    expect(loadBundleManifest({ rootDir: root, bundleFormat: "claude" })).toEqual(before);
    const fresh = withPluginCache(createPluginCache(), () =>
      loadBundleManifest({ rootDir: root, bundleFormat: "claude" }),
    );
    expect(fresh.ok && fresh.manifest.skills).toContain("skills");
  });

  it("shares checked aliases without discarding artifacts resolved before the first file read", () => {
    const parent = tempDirs.make("plugin-alias-generation-");
    const root = path.join(parent, "package");
    const alias = path.join(parent, "alias");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.symlinkSync(root, alias, "dir");
    const aliasRecord = getPluginCacheRoot(alias);
    aliasRecord.artifacts.set("missing-surface", null);
    const first = readPluginCacheFile({
      rootDir: alias,
      relativePath: "package.json",
      rejectHardlinks: true,
    });
    const open = vi.spyOn(fs, "openSync");
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: true }),
    ).toBe(first);
    expect(getPluginCacheRoot(root).artifacts.has("missing-surface")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps checked source aliases authoritative within their explicit cache generation", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-source-alias-"));
    const root = path.join(parent, "package with spaces");
    const alias = path.join(parent, "alias with spaces");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "api.cjs"), "module.exports = {};\n");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = path.join(alias, "api.cjs");
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
    const root = tempDirs.make("plugin-hardlink-generation-");
    const source = path.join(root, "source.json");
    fs.writeFileSync(source, "{}");
    fs.linkSync(source, path.join(root, "package.json"));
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: false })
        .ok,
    ).toBe(true);
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: true })
        .ok,
    ).toBe(false);
    expect(pluginCacheExistsSync(path.join(root, "missing.json"))).toBe(false);
    fs.writeFileSync(path.join(root, "missing.json"), "{}");
    expect(pluginCacheExistsSync(path.join(root, "missing.json"))).toBe(false);
  });
  it.each(["missing", "empty"])(
    "carries package facts and %s artifact directories until refresh",
    (directory) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-plugin-cache-"));
      const bundledDir = path.join(root, "bundled");
      const pluginDir = path.join(bundledDir, "generation-owner");
      fs.mkdirSync(pluginDir, { recursive: true });
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const packagePath = path.join(pluginDir, "package.json");
      const distDir = path.join(pluginDir, "dist");
      if (directory === "empty") {
        fs.mkdirSync(distDir);
      }
      const writeGeneration = (version: string) => {
        const manifest = JSON.stringify({
          id: "generation-owner",
          version,
          configSchema: { type: "object" },
        });
        const packageJson = JSON.stringify({
          name: "@fixture/generation-owner",
          version,
          openclaw: { extensions: ["./index.js"] },
        });
        fs.writeFileSync(manifestPath, manifest);
        fs.writeFileSync(packagePath, packageJson);
        return { manifest, packageJson };
      };
      const first = writeGeneration("1.0.0");
      fs.writeFileSync(
        path.join(pluginDir, "index.js"),
        'throw new Error("metadata executed runtime");',
      );
      const env = {
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
      const discovery = discoverOpenClawPlugins({ env, installRecords: {} });
      expect(
        discovery.candidates.find((candidate) => candidate.idHint === "generation-owner"),
      ).toBeDefined();
      writeGeneration("2.0.0");
      const open = vi.spyOn(fs, "openSync");
      const read = vi.spyOn(fs, "readFileSync");
      expect(discoverOpenClawPlugins({ env, installRecords: {} })).toBe(discovery);
      const registry = loadPluginManifestRegistryCore({ env, discovery, installRecords: {} });
      const exists = vi.spyOn(fs, "existsSync");
      const records = buildInstalledPluginIndexRecords({
        candidates: discovery.candidates,
        registry,
        config: {},
        diagnostics: [],
        installRecords: {},
      });
      expect(registry.plugins.find((plugin) => plugin.id === "generation-owner")?.version).toBe(
        "1.0.0",
      );
      expect(records.find((record) => record.pluginId === "generation-owner")).toMatchObject({
        manifestHash: crypto.createHash("sha256").update(first.manifest).digest("hex"),
        packageJson: { hash: crypto.createHash("sha256").update(first.packageJson).digest("hex") },
      });
      for (const filePath of [manifestPath, packagePath]) {
        expect(open.mock.calls.filter(([file]) => String(file) === filePath)).toEqual([]);
        expect(read.mock.calls.filter(([file]) => String(file) === filePath)).toEqual([]);
      }
      expect(
        exists.mock.calls.filter(([file]) => String(file).startsWith(`${distDir}${path.sep}`)),
      ).toEqual([]);
      expect(records[0]?.doctorContractHash).toBeUndefined();
      fs.mkdirSync(distDir, { recursive: true });
      const contract = "module.exports = {};";
      fs.writeFileSync(path.join(distDir, "doctor-contract-api.cjs"), contract);
      const buildRecords = () =>
        buildInstalledPluginIndexRecords({
          candidates: discovery.candidates,
          registry,
          config: {},
          diagnostics: [],
          installRecords: {},
        });
      expect(buildRecords()[0]?.doctorContractHash).toBeUndefined();
      invalidatePluginCacheMetadata(getProcessPluginCache());
      expect(buildRecords()[0]?.doctorContractHash).toBe(
        crypto.createHash("sha256").update(contract).digest("hex"),
      );
    },
  );

  it.each(["EACCES", "EPERM"])(
    "finds Doctor artifacts when directory listing fails with %s",
    (code) => {
      const rootDir = fs.realpathSync(tempDirs.make("plugin-artifact-list-denied-"));
      const distDir = path.join(rootDir, "dist");
      fs.mkdirSync(distDir);
      const modulePath = path.join(distDir, "doctor-contract-api.cjs");
      fs.writeFileSync(modulePath, "module.exports = {};");
      vi.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw Object.assign(new Error("directory listing denied"), { code });
      });
      expect(resolvePluginDoctorContractArtifact({ rootDir, origin: "global" })).toEqual({
        modulePath,
        boundaryRoot: rootDir,
      });
    },
  );
});

it("lets the last cache borrower own retirement after the requesting scope closes", async () => {
  const requester = new AsyncWorkScope();
  const borrower = new AsyncWorkScope();
  const cache = createPluginCache();
  const instance = new PluginInstance("cache-borrower");
  cache.instances.add(instance);
  const release = retainPluginCache(cache);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const cleaned = vi.fn();
  instance.lifecycle.onDispose(async () => {
    entered.resolve();
    await finish.promise;
    cleaned();
  });
  let retirement: ReturnType<typeof retirePluginCache> | undefined;
  await requester.track(() => {
    retirement = retirePluginCache(cache);
    void retirement.catch(() => {});
  });
  await requester.drain();
  let closed = false;
  const released = borrower.track(release);
  const drain = borrower.drain().then(() => {
    closed = true;
  });
  try {
    await Promise.race([entered.promise, retirement]);
    expect(closed).toBe(false);
    finish.resolve();
    await expect(retirement).resolves.toMatchObject({ failures: [] });
    await drain;
    expect(cleaned).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  } finally {
    release();
    finish.resolve();
    await Promise.allSettled([retirement, released, drain]);
  }
});

it.each([false, true])(
  "owns cache cleanup when retirement runs in a closed request scope (borrowed: %s)",
  async (borrowed) => {
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
  },
);

it("retires a cache released by a borrower captured before package replacement", async () => {
  const requester = new AsyncWorkScope();
  const cache = createPluginCache();
  const instance = new PluginInstance("released-cache-borrower");
  cache.instances.add(instance);
  retainPluginCache(cache);
  const retainers = resolveGlobalSingleton(
    Symbol.for("openclaw.pluginCacheRetainers"),
    () =>
      new WeakMap<
        object,
        {
          references: Set<object>;
          settled: { resolve: () => void };
          beginRetirement?: () => void;
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
  const cleaned = vi.fn();
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
    // Unstick the broken implementation's unpublished cleanup after the regression fails.
    retained.beginRetirement?.();
    finish.resolve();
    await retirement.catch(() => {});
  }
});
