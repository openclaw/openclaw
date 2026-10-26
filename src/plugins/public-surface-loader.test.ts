import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { resetPluginCache } from "./plugin-cache.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";
import { captureThrownError, writeArtifact } from "./public-surface.test-support.js";

const tempDirs = createTempDirTracker();
const publicArtifact = { dirName: "demo", artifactBasename: "api.js" };
const candidateArtifacts = { dirName: "demo", artifactCandidates: ["api.js", "runtime-api.js"] };
function setBundledDir(bundledPluginsDir: string, trust = true) {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  if (trust) {
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  }
}
function bundledArtifact(
  contents = 'export const marker = "demo";\n',
  basename = "api.js",
  trust = true,
) {
  const bundledPluginsDir = path.join(tempDirs.make("openclaw-public-surface-loader-"), "dist");
  const modulePath = writeArtifact(path.join(bundledPluginsDir, "demo", basename), contents);
  setBundledDir(bundledPluginsDir, trust);
  return { bundledPluginsDir, modulePath };
}
function pluginFixture(type = "commonjs") {
  const root = tempDirs.make("openclaw-public-surface-loader-");
  const bundledPluginsDir = path.join(root, "extensions");
  const pluginRoot = path.join(bundledPluginsDir, "demo");
  writeArtifact(path.join(pluginRoot, "package.json"), JSON.stringify({ type }));
  return { root, bundledPluginsDir, pluginRoot };
}
async function freshLoader(scope: string) {
  const loader = await importFreshModule<typeof import("./public-surface-loader.js")>(
    import.meta.url,
    `./public-surface-loader.js?scope=${scope}`,
  );
  return {
    load: loader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>,
    candidates: loader.loadBundledPluginPublicArtifactModuleFromCandidatesSync<{ marker: string }>,
    installed: loader.loadPluginPublicArtifactModuleSync<{ marker: string }>,
  };
}
function mockNativeMarker() {
  vi.doMock("./native-module-require.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./native-module-require.js")>()),
    tryNativeRequireJavaScriptModule: (modulePath: string) => ({
      ok: true,
      moduleExport: { marker: path.basename(path.dirname(modulePath)) },
    }),
  }));
}

afterEach(() => {
  resetPluginCache();
  tempDirs.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("./bundled-dir.js");
  vi.doUnmock("./native-module-require.js");
  vi.doUnmock("./public-surface-runtime.js");
  vi.doUnmock("./sdk-alias.js");
  vi.unstubAllEnvs();
});

describe("bundled plugin public surface loader", () => {
  it("loads retained admission checks only from the candidate despite runtime bundle policy", async () => {
    const candidateRoot = tempDirs.make("openclaw-retained-admission-");
    const source = path.join(candidateRoot, "dist", "state-retention", "demo.js");
    writeArtifact(path.join(candidateRoot, "package.json"), '{"type":"commonjs"}\n');
    writeArtifact(source, 'module.exports = { marker: "candidate" };\n');
    const foreign = tempDirs.make("openclaw-foreign-retention-");
    writeArtifact(
      path.join(foreign, "demo", "state-retention-api.js"),
      'throw new Error("foreign artifact executed");\n',
    );
    const env = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: foreign,
    };
    const loader = await freshLoader("retained-admission");
    const params = { dirName: "demo", artifactCandidates: ["state-retention-api.js"], env };
    expect(loader.candidates(params)).toBeNull();
    const retained = { ...params, retainedAt: candidateRoot };
    expect(loader.candidates(retained)?.marker).toBe("candidate");
    expect(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS).toBe("1");
    expect(() => loader.candidates({ ...retained, dirName: "../demo" })).toThrow(
      "single directory",
    );
  });

  it("loads candidate artifacts from each caller's environment without changing process.env", async () => {
    const createEnvironment = (marker: string) => {
      const { bundledPluginsDir, pluginRoot } = pluginFixture();
      writeArtifact(
        path.join(pluginRoot, "api.js"),
        `module.exports = { marker: ${JSON.stringify(marker)} };\n`,
      );
      return {
        VITEST: "true",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
    };
    const firstEnvironment = createEnvironment("first");
    const secondEnvironment = createEnvironment("second");
    const loader = await freshLoader("caller-environment");
    const load = (env: NodeJS.ProcessEnv) => loader.candidates({ ...candidateArtifacts, env });
    expect(load(firstEnvironment)?.marker).toBe("first");
    expect(
      loader.candidates({
        dirName: "demo",
        artifactCandidates: ["missing.js", "api.js"],
        env: secondEnvironment,
      })?.marker,
    ).toBe("second");
    expect(load(firstEnvironment)?.marker).toBe("first");
  });

  it.each([false, true])(
    "separates disabled and enabled fallback caches with disabledFirst=%s",
    async (disabledFirst) => {
      const { root: tempRoot, pluginRoot } = pluginFixture();
      writeArtifact(path.join(pluginRoot, "api.js"), 'module.exports = { marker: "enabled" };\n');
      // Both environments lack a discovered tree; only the package source fallback exists.
      vi.doMock("./bundled-dir.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./bundled-dir.js")>()),
        resolveBundledPluginsDir: () => undefined,
      }));
      vi.doMock("./sdk-alias.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./sdk-alias.js")>()),
        resolveLoaderPackageRoot: () => tempRoot,
      }));
      const loader = await freshLoader(`disabled-cache-${disabledFirst}`);
      const load = (disabled: boolean) =>
        loader.candidates({
          dirName: "demo",
          artifactCandidates: ["api.js"],
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: disabled ? "1" : "0" },
        });
      expect(load(disabledFirst)?.marker ?? null).toBe(disabledFirst ? null : "enabled");
      expect(load(!disabledFirst)?.marker ?? null).toBe(disabledFirst ? "enabled" : null);
      expect(load(disabledFirst)?.marker ?? null).toBe(disabledFirst ? null : "enabled");
    },
  );

  it("keeps auto-resolved bundled roots on built public artifacts", async () => {
    // The non-isolated plugin shard may have already imported the native loader.
    vi.resetModules();
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist", "extensions");
    const modulePath = path.join(bundledPluginsDir, "demo", "provider-policy-api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "built";\n', "utf8");

    const resolveBundledPluginPublicSurfacePath = vi.fn(() => modulePath);
    vi.doMock("./bundled-dir.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./bundled-dir.js")>();
      return {
        ...actual,
        resolveBundledPluginsDir: () => bundledPluginsDir,
      };
    });
    vi.doMock("./public-surface-runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./public-surface-runtime.js")>();
      return {
        ...actual,
        resolveBundledPluginPublicSurfacePath,
      };
    });
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      tryNativeRequireJavaScriptModule: (target: string) => ({
        ok: true,
        moduleExport: { marker: path.basename(path.dirname(target)) },
      }),
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=auto-bundled-built-artifacts");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "provider-policy-api.js",
      }).marker,
    ).toBe("demo");
    expect(resolveBundledPluginPublicSurfacePath).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledPluginsDir,
        bundledPluginsDirMode: "explicit",
      }),
    );
  });

  it("uses native require for Windows dist public artifact loads", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "windows-dist-ok" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      tryNativeRequireJavaScriptModule: () => ({
        ok: true,
        moduleExport: { marker: "windows-dist-ok" },
      }),
    }));

    await withMockedWindowsPlatform(async () => {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(import.meta.url, "./public-surface-loader.js?scope=windows-dist-jiti");
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const bundledPluginsDir = path.join(tempRoot, "dist");
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

      const modulePath = path.join(bundledPluginsDir, "demo", "provider-policy-api.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, 'export const marker = "windows-dist-ok";\n', "utf8");

      expect(
        publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "provider-policy-api.js",
        }).marker,
      ).toBe("windows-dist-ok");
      expect(createJiti).not.toHaveBeenCalled();
    });
  });

  it("loads import-only dependencies under tsx and retains bundled code across cache generations", () => {
    const tempRoot = tempDirs.make("openclaw-public-surface-source-");
    const bundledPluginsDir = path.join(tempRoot, "extensions");
    const pluginRoot = path.join(bundledPluginsDir, "demo");
    const dependencyRoot = path.join(pluginRoot, "node_modules", "import-only-fixture");
    const modulePath = path.join(pluginRoot, "secret-contract-api.ts");
    const dependencyPath = path.join(dependencyRoot, "index.js");
    writeArtifact(
      path.join(dependencyRoot, "package.json"),
      JSON.stringify({ type: "module", exports: { node: { import: "./index.js" } } }),
    );
    writeArtifact(dependencyPath, 'export const marker = "original";\n');
    writeArtifact(path.join(tempRoot, "shared.cjs"), "module.exports = {};\n");
    writeArtifact(
      modulePath,
      'export { marker } from "import-only-fixture";\nexport { default as shared } from "../../shared.cjs";\n',
    );
    const moduleUrl = (
      entrypoint: (typeof pluginProcessRuntimeEntrypoints)[keyof typeof pluginProcessRuntimeEntrypoints],
    ) => JSON.stringify(resolveRuntimeWorkerUrl(entrypoint).href);
    const result = spawnNodeEvalSync(
      `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import { loadBundledPluginPublicArtifactModuleSync, loadPluginPublicArtifactModuleSync } from ${moduleUrl(pluginProcessRuntimeEntrypoints.publicSurfaceLoader)};
        import { loadFacadeModuleAtLocationSync } from ${moduleUrl(pluginProcessRuntimeEntrypoints.facadeLoader)};
        import { clearPluginMetadataLifecycleCaches } from ${moduleUrl(pluginProcessRuntimeEntrypoints.metadataLifecycle)};
        const load = () => loadBundledPluginPublicArtifactModuleSync({ dirName: "demo", artifactBasename: "secret-contract-api.js" });
        const first = load();
        assert.equal(first.marker, "original");
        assert.equal(load(), first);
        assert.equal(loadPluginPublicArtifactModuleSync({ pluginRoot: ${JSON.stringify(pluginRoot)}, artifactBasename: "secret-contract-api.js" }), first);
        assert.equal(loadFacadeModuleAtLocationSync({ location: { modulePath: ${JSON.stringify(modulePath)}, boundaryRoot: ${JSON.stringify(pluginRoot)} }, trackedPluginId: "demo" }), first);
        fs.writeFileSync(${JSON.stringify(dependencyPath)}, 'export const marker = "replacement";\\n');
        assert.equal(load(), first);
        clearPluginMetadataLifecycleCaches();
        const refreshed = load();
        assert.notEqual(refreshed, first);
        assert.equal(refreshed.marker, "original");
        assert.equal(refreshed.shared, first.shared);
        console.log("source artifact import, identity, and lifecycle verified");
      `,
      {
        // The plugin remains TypeScript: this probe owns source-loader behavior.
        imports: [pathToFileURL(path.join(process.cwd(), "scripts/tsx.mjs")).href],
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: tempRoot,
          USERPROFILE: tempRoot,
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
          VITEST: "true",
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          JITI_FS_CACHE: "0",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("source artifact import, identity, and lifecycle verified");
  });

  it("keeps package-local dist public artifacts on the native path for source plugin roots", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "jiti-should-not-run" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      tryNativeRequireJavaScriptModule: (modulePath: string) => ({
        ok: true,
        moduleExport: {
          marker: modulePath.includes(`${path.sep}dist${path.sep}`) ? "dist" : "source",
        },
      }),
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=source-root-local-dist-public-artifacts");
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "extensions");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const sourcePath = path.join(bundledPluginsDir, "demo", "api.ts");
    const distPath = path.join(bundledPluginsDir, "demo", "dist", "api.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(sourcePath, 'export const marker = "source";\n', "utf8");
    fs.writeFileSync(distPath, 'export const marker = "dist";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "api.js",
      }).marker,
    ).toBe("dist");
    expect(createJiti).not.toHaveBeenCalled();
  });

  it.each([
    { firstLocation: "root", nextLocation: "dist" },
    { firstLocation: "dist", nextLocation: "root" },
  ] as const)(
    "refreshes native ESM artifact locations from $firstLocation to $nextLocation with plugin metadata",
    async ({ firstLocation, nextLocation }) => {
      const loader = await freshLoader(`esm-artifact-relocation-${firstLocation}-${nextLocation}`);
      const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
      const { bundledPluginsDir, pluginRoot: pluginDir } = pluginFixture("module");
      setBundledDir(bundledPluginsDir);
      const artifactPath = (location: "root" | "dist") =>
        path.join(pluginDir, ...(location === "dist" ? ["dist"] : []), "api.js");
      const replaceArtifact = (location: "root" | "dist") => {
        writeArtifact(
          artifactPath(location),
          `export const marker = ${JSON.stringify(location)};\n`,
        );
      };
      const loadArtifact = () => loader.load(publicArtifact).marker;
      replaceArtifact(firstLocation);
      expect(loadArtifact()).toBe(firstLocation);
      fs.unlinkSync(artifactPath(firstLocation));
      replaceArtifact(nextLocation);
      expect(loadArtifact()).toBe(firstLocation);
      clearPluginMetadataLifecycleCaches();
      expect(loadArtifact()).toBe(nextLocation);
    },
  );

  it("shares warm installed artifacts with facades and reloads their dependencies after metadata changes", async () => {
    const loader = await freshLoader("installed-artifact-replacement");
    const { loadFacadeModuleAtLocationSync } = await import("../plugin-sdk/facade-loader.js");
    const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
    const tempRoot = fs.realpathSync(tempDirs.make("openclaw-public-surface-replacement-"));
    const pluginRoot = path.join(tempRoot, "installed-plugin");
    const modulePath = path.join(pluginRoot, "api.js");
    const dependencyPath = path.join(pluginRoot, "dependency.js");
    writeArtifact(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
    const replaceArtifact = (marker: string) => {
      writeArtifact(dependencyPath, `module.exports = ${JSON.stringify(marker)};\n`);
      writeArtifact(modulePath, 'module.exports = { marker: require("./dependency.js") };\n');
    };
    const loadArtifact = () => loader.installed({ pluginRoot, artifactBasename: "api.js" });
    replaceArtifact("retired");
    const first = loadArtifact();
    const probes = [
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "realpathSync"),
      vi.spyOn(fs, "statSync"),
      vi.spyOn(fs, "openSync"),
    ];
    expect(loadArtifact()).toBe(first);
    expect(
      loadFacadeModuleAtLocationSync({
        location: { modulePath, boundaryRoot: pluginRoot },
        trackedPluginId: "shared-artifact",
      }),
    ).toBe(first);
    expect(first.marker).toBe("retired");
    for (const probe of probes) {
      expect(probe).not.toHaveBeenCalled();
      probe.mockRestore();
    }
    replaceArtifact("replacement");
    expect(loadArtifact()).toBe(first);
    clearPluginMetadataLifecycleCaches();
    expect(loadArtifact().marker).toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "allows hardlinked bundled public artifacts under the trusted bundled root",
    async () => {
      mockNativeMarker();
      const loader = await freshLoader("bundled-hardlink-public-artifacts");
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const bundledPluginsDir = path.join(tempRoot, "dist");
      const sourcePath = path.join(tempRoot, "api-source.js");
      const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      writeArtifact(sourcePath, 'export const marker = "demo";\n');
      fs.linkSync(sourcePath, modulePath);
      expect(fs.statSync(modulePath).nlink).toBeGreaterThan(1);
      setBundledDir(bundledPluginsDir);
      expect(loader.load(publicArtifact).marker).toBe("demo");
      const installed = { pluginRoot: bundledPluginsDir, artifactBasename: "demo/api.js" };
      expect(() => loader.installed(installed)).toThrow(
        "Unable to open plugin public surface demo/api.js",
      );
    },
  );

  it("retains missing public artifacts until the plugin cache generation changes", async () => {
    mockNativeMarker();
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    fs.mkdirSync(bundledPluginsDir, { recursive: true });
    setBundledDir(bundledPluginsDir);
    const loader = await freshLoader("missing-location-retry");
    const missingError = captureThrownError(() => loader.load(publicArtifact));
    const missingMessage = "Unable to resolve bundled plugin public surface demo/api.js";
    expect(missingError.message).toBe(missingMessage);
    writeArtifact(
      path.join(bundledPluginsDir, "demo", "api.js"),
      'export const marker = "demo";\n',
    );
    expect(() => loader.load(publicArtifact)).toThrow(missingMessage);
    const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
    clearPluginMetadataLifecycleCaches();
    expect(loader.load(publicArtifact).marker).toBe("demo");
  });

  it("rejects public artifacts that change after boundary validation", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "should-not-load" })));
    vi.doMock("jiti", () => ({ createJiti }));
    const loader = await freshLoader("post-validation-identity");
    const { modulePath } = bundledArtifact(undefined, undefined, false);
    const realStatSync = fs.statSync.bind(fs);
    const moduleRealPath = fs.realpathSync(modulePath);
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      const stat = realStatSync(target, options);
      if (stat === undefined || fs.realpathSync(target) !== moduleRealPath) {
        return stat;
      }
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
      });
    });
    expect(() => loader.load(publicArtifact)).toThrow(/changed after validation/);
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("skips missing surfaces in candidate fallback", async () => {
    const fresh = await importFreshModule<typeof import("./public-surface-loader.js")>(
      import.meta.url,
      "./public-surface-loader.js?scope=candidate-catcher-instanceof",
    );
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    fs.mkdirSync(bundledPluginsDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const result = fresh.loadBundledPluginPublicArtifactModuleFromCandidatesSync<{
      marker: string;
    }>({
      dirName: "missing-plugin",
      artifactCandidates: ["api.js", "runtime-api.js"],
    });
    expect(result).toBeNull();
  });

  it("re-throws generic candidate load errors with the legacy missing prefix", async () => {
    const loader = await freshLoader("candidate-catcher-generic-error");
    bundledArtifact(
      'throw new Error("Unable to resolve bundled plugin public surface synthetic loader failure");\n',
      "api.cjs",
    );
    const error = captureThrownError(() => loader.candidates(candidateArtifacts));
    expect(error.message).toBe(
      "Unable to resolve bundled plugin public surface synthetic loader failure",
    );
  });

  it("re-throws typed missing errors raised while loading a resolved candidate", async () => {
    const nestedError = new MissingPublicSurfaceError("nested public surface is missing");
    vi.doMock("./native-module-require.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./native-module-require.js")>()),
      tryNativeRequireJavaScriptModule: () => {
        throw nestedError;
      },
    }));
    const loader = await freshLoader("candidate-catcher-nested-missing-error");
    bundledArtifact();
    const error = captureThrownError(() => loader.candidates(candidateArtifacts));
    expect(error).toBe(nestedError);
  });
});
