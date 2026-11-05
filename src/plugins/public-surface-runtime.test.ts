import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./package-entrypoints.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { loadPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import {
  resolveBundledPluginPublicSurfacePath,
  resolveBundledPluginSourcePublicSurfacePath,
  resolvePluginRootPublicSurfaceLocation,
} from "./public-surface-runtime.js";
import { writeArtifact } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const noBundledPluginOverrideEnv = {
  ...process.env,
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
} satisfies NodeJS.ProcessEnv;
function resolveBundled(
  rootDir: string,
  overrides: Partial<Parameters<typeof resolveBundledPluginPublicSurfacePath>[0]> = {},
) {
  return resolveBundledPluginPublicSurfacePath({
    rootDir,
    dirName: "demo",
    artifactBasename: "api.js",
    ...overrides,
  });
}
function resolveSource(sourceRoot: string, artifactBasename: string, dirName = "demo") {
  return resolveBundledPluginSourcePublicSurfacePath({ sourceRoot, dirName, artifactBasename });
}

describe("bundled plugin public surface runtime", () => {
  it.each([false, true])(
    "loads sidecars from the selected artifact (runtime registered: %s)",
    async (runtimeRegistrationComplete) => {
      const root = tempDirs.make("openclaw-public-surface-selected-");
      const sourceRoot = path.join(root, "extensions/demo");
      const builtRoot = path.join(root, "dist/extensions/demo");
      const source = writeArtifact(path.join(sourceRoot, "index.ts"));
      writeArtifact(path.join(sourceRoot, "api.ts"), 'export const family = "source";');
      writeArtifact(path.join(builtRoot, "package.json"), '{"type":"module"}');
      const builtSource = writeArtifact(path.join(builtRoot, "index.js"));
      const builtSurface = writeArtifact(
        path.join(builtRoot, "api.js"),
        'export const family = "built";',
      );
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({
        id: "demo",
        origin: "bundled",
        source,
        rootDir: sourceRoot,
      });
      registry.plugins.push(record);
      bindPluginRuntimeArtifactSelection(record, {
        runtimeEntry: runtimeRegistrationComplete
          ? { source: builtSource, rootDir: builtRoot }
          : { source, rootDir: sourceRoot },
        setupEntry: { source: builtSource, rootDir: builtRoot },
      }).runtimeRegistrationComplete = runtimeRegistrationComplete;
      const instance = new PluginInstance(record.id, { record, registry });
      const cache = createPluginCache();
      try {
        withPluginCache(cache, () => {
          bindPluginInstanceModuleLoader({
            instance,
            origin: record.origin,
            source: builtSource,
            rootDir: builtRoot,
          });
        });
        const resolved = withPluginRuntimeRegistryScope(registry, () =>
          withPluginCache(cache, () =>
            resolvePluginRootPublicSurfaceLocation({
              pluginRoot: sourceRoot,
              pluginId: record.id,
              artifactBasename: "api.js",
            }),
          ),
        );
        expect(resolved).toEqual({ modulePath: builtSurface, boundaryRoot: builtRoot });
        const loaded = withPluginRuntimeRegistryScope(registry, () =>
          withPluginCache(cache, () =>
            loadPluginPublicArtifactModuleSync<{ family: string }>({
              pluginRoot: sourceRoot,
              artifactBasename: "api.js",
              origin: "bundled",
            }),
          ),
        );
        expect(loaded.family).toBe("built");
      } finally {
        await instance.dispose();
        await retirePluginCache(cache);
      }
    },
  );

  it.each<[string, string, string[], string | null]>([
    ["absent artifact", "index.js", [], null],
    ["JavaScript dist", "index.js", ["api.ts", "dist/api.js"], "dist/api.js"],
    ["nested TypeScript", "src/index.ts", ["src/api.ts", "src/api.js", "api.js"], "src/api.ts"],
  ])(
    "checks captured artifact paths once while preserving precedence (%s)",
    async (_name, entry, artifacts, expected) => {
      const rootDir = tempDirs.make("openclaw-public-surface-probes-");
      const source = path.join(rootDir, entry);
      for (const relativePath of [entry, ...artifacts]) {
        writeArtifact(path.join(rootDir, relativePath), "export default {};\n");
      }
      const cache = createPluginCache();
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({
        id: "captured-path-probes",
        rootDir,
        source,
        origin: "global",
      });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      try {
        withPluginCache(cache, () => {
          bindPluginInstanceModuleLoader({ instance, origin: record.origin, source, rootDir });
        });
        const hasSource = vi.spyOn(instance, "hasModuleSource");
        const resolved = withPluginRuntimeRegistryScope(registry, () =>
          withPluginCache(cache, () =>
            resolvePluginRootPublicSurfaceLocation({
              pluginRoot: rootDir,
              pluginId: record.id,
              artifactBasename: "api.js",
            }),
          ),
        );
        expect(resolved).toEqual(
          expected === null
            ? null
            : { modulePath: path.join(rootDir, expected), boundaryRoot: rootDir },
        );
        const paths = hasSource.mock.calls.map(([filename]) => filename);
        expect(paths.length).toBeGreaterThan(0);
        expect(paths).toHaveLength(new Set(paths).size);
      } finally {
        await instance.dispose();
        await retirePluginCache(cache);
      }
    },
  );

  it.each([
    ["dist", "config-doctor"],
    ["dist-runtime", "config-doctor"],
    ["dist", "state-retention"],
    ["dist-runtime", "state-retention"],
  ])("retains %s/%s entrypoints after externalization", (dist, surface) => {
    const rootDir = tempDirs.make("openclaw-retained-doctor-");
    const retained = writeArtifact(path.join(rootDir, dist, surface, "demo.js"));
    const params = { artifactBasename: `${surface}-api.js`, env: noBundledPluginOverrideEnv };
    const resolve = (overrides: Partial<Parameters<typeof resolveBundled>[1]> = {}) =>
      resolveBundled(rootDir, { ...params, ...overrides });
    expect(resolve()).toBe(retained);
    expect(resolve({ bundledPluginsDir: path.join(rootDir, dist, "extensions") })).toBe(retained);
    for (const artifactBasename of ["doctor-contract-api.js", "api.js"]) {
      expect(resolve({ artifactBasename })).toBeNull();
    }
    expect(resolve({ bundledPluginsDir: tempDirs.make("openclaw-foreign-plugins-") })).toBeNull();
    const disabled = { ...noBundledPluginOverrideEnv, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    expect(resolve({ env: disabled })).toBeNull();
  });

  it("exports the canonical public surface source extension list", () => {
    expect(PUBLIC_SURFACE_SOURCE_EXTENSIONS).toEqual([
      ".ts",
      ".mts",
      ".js",
      ".mjs",
      ".cts",
      ".cjs",
    ]);
  });

  it("accepts a public surface whose Windows root and entry use physical aliases", () => {
    const parent = fs.realpathSync(tempDirs.make("openclaw-public-surface-alias-"));
    const root = path.join(parent, "canonical-root");
    const alias = path.join(parent, "root-alias");
    const entrySource = path.join(root, "index.js");
    const publicSurface = path.join(root, "api.js");
    writeArtifact(entrySource, "export default {};\n");
    writeArtifact(publicSurface);
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const params = { pluginRoot: alias, entrySource, artifactBasename: "api.js" };
    expect(resolvePluginRootPublicSurfaceLocation(params)).toEqual({
      modulePath: publicSurface,
      boundaryRoot: alias,
    });
  });

  it.each(["my-ngc:nvidia", "../outside", "..\\outside", ".", ".."])(
    "continues rejecting %s as an actual bundled plugin directory",
    (dirName) => {
      const rootDir = tempDirs.make("openclaw-public-surface-runtime-");
      expect(() => resolveSource(rootDir, "api.js", dirName)).toThrow(/must be a single directory/);
      expect(() => resolveBundled(rootDir, { dirName })).toThrow(/must be a single directory/);
    },
  );

  it("resolves source public surfaces from the shared extension list", () => {
    const sourceRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const modulePath = path.join(sourceRoot, "demo", "api.mts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export {};\n", "utf8");

    expect(
      resolveBundledPluginSourcePublicSurfacePath({
        sourceRoot,
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(modulePath);
  });

  it("falls back from package dist overrides to the source extension tree", () => {
    const packageRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const sourceModulePath = path.join(packageRoot, "extensions", "demo", "api.ts");
    fs.mkdirSync(path.dirname(sourceModulePath), { recursive: true });
    fs.writeFileSync(sourceModulePath, "export const marker = 'source';\n", "utf8");

    const bundledPluginsDir = path.join(packageRoot, "dist", "extensions");
    fs.mkdirSync(path.join(bundledPluginsDir, "demo"), { recursive: true });

    expect(
      resolveBundledPluginPublicSurfacePath({
        rootDir: packageRoot,
        bundledPluginsDir,
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(sourceModulePath);
  });

  it("prefers package-local dist artifacts before source artifacts in source plugin trees", () => {
    const packageRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const sourceModulePath = path.join(packageRoot, "extensions", "demo", "api.ts");
    const packageLocalDistModulePath = path.join(
      packageRoot,
      "extensions",
      "demo",
      "dist",
      "api.js",
    );
    fs.mkdirSync(path.dirname(sourceModulePath), { recursive: true });
    fs.mkdirSync(path.dirname(packageLocalDistModulePath), { recursive: true });
    fs.writeFileSync(sourceModulePath, "export const marker = 'source';\n", "utf8");
    fs.writeFileSync(packageLocalDistModulePath, "export const marker = 'local-dist';\n", "utf8");

    expect(
      resolveBundledPluginPublicSurfacePath({
        rootDir: packageRoot,
        bundledPluginsDir: path.join(packageRoot, "extensions"),
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(packageLocalDistModulePath);
  });

  it("prefers source public surfaces over stale auto-resolved dist artifacts in source checkouts", () => {
    const packageRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const sourceModulePath = writeArtifact(path.join(packageRoot, "extensions", "demo", "api.ts"));
    writeArtifact(path.join(packageRoot, "dist", "extensions", "demo", "api.js"));
    expect(
      resolveBundled(packageRoot, {
        bundledPluginsDir: path.join(packageRoot, "dist", "extensions"),
        bundledPluginsDirMode: "auto",
        env: noBundledPluginOverrideEnv,
      }),
    ).toBe(sourceModulePath);
  });

  it("keeps explicit bundled dist roots ahead of source public surfaces", () => {
    const packageRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const sourceModulePath = path.join(packageRoot, "extensions", "demo", "api.ts");
    const distModulePath = path.join(packageRoot, "dist", "extensions", "demo", "api.js");
    fs.mkdirSync(path.dirname(sourceModulePath), { recursive: true });
    fs.mkdirSync(path.dirname(distModulePath), { recursive: true });
    fs.writeFileSync(sourceModulePath, "export const marker = 'source';\n", "utf8");
    fs.writeFileSync(distModulePath, "export const marker = 'dist';\n", "utf8");

    expect(
      resolveBundledPluginPublicSurfacePath({
        rootDir: packageRoot,
        bundledPluginsDir: path.join(packageRoot, "dist", "extensions"),
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(distModulePath);
  });

  it("falls back from an incomplete package dist-runtime override to packaged dist", () => {
    const packageRoot = tempDirs.make("openclaw-public-surface-runtime-");
    const distModulePath = writeArtifact(
      path.join(packageRoot, "dist", "extensions", "demo", "api.js"),
    );

    const runtimeBundledPluginsDir = path.join(packageRoot, "dist-runtime", "extensions");
    fs.mkdirSync(path.join(runtimeBundledPluginsDir, "demo"), { recursive: true });

    expect(resolveBundled(packageRoot, { bundledPluginsDir: runtimeBundledPluginsDir })).toBe(
      distModulePath,
    );
  });

  it("allows plugin-local nested artifact paths", () => {
    const sourceRoot = tempDirs.make("openclaw-local-public-surface-");
    for (const artifactBasename of ["src/outbound-adapter.js", "./test-api.js"]) {
      const modulePath = writeArtifact(path.resolve(sourceRoot, "demo", artifactBasename));
      expect(resolveSource(sourceRoot, artifactBasename)).toBe(modulePath);
    }
  });

  it("rejects artifact paths that escape the plugin root", () => {
    const sourceRoot = tempDirs.make("openclaw-local-public-surface-");
    for (const artifactBasename of [
      "../outside.js",
      "src/../outside.js",
      "/tmp/outside.js",
      "..\\outside.js",
      "C:outside.js",
      "src/C:outside.js",
    ]) {
      expect(() => resolveSource(sourceRoot, artifactBasename)).toThrow(/must stay plugin-local/);
    }
  });
});
