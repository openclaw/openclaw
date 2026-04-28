import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBundledPluginsDirOverrideForTest } from "../plugins/bundled-dir.js";
import {
  clearBundledRuntimeDependencyNodePaths,
  resolveBundledRuntimeDependencyInstallRoot,
} from "../plugins/bundled-runtime-deps.js";
import { shouldExpectNativeJitiForJavaScriptTestRuntime } from "../test-utils/jiti-runtime.js";
import {
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModule,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeLoaderStateForTest,
  setFacadeLoaderJitiFactoryForTest,
} from "./facade-loader.js";
import { listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds } from "./facade-runtime.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalPluginStageDir = process.env.OPENCLAW_PLUGIN_STAGE_DIR;
const trustedBundledFixturesRoot = path.resolve("dist-runtime", "extensions");
const FACADE_LOADER_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";
const STAGED_RUNTIME_DEP_NAME = "openclaw-facade-loader-runtime-dep";
type FacadeLoaderJitiFactory = NonNullable<Parameters<typeof setFacadeLoaderJitiFactoryForTest>[0]>;
const trustedBundledFixtureDirs: string[] = [];

function forceNodeRuntimeVersionsForTest(): () => void {
  const originalVersions = process.versions;
  const nodeVersions = { ...originalVersions } as NodeJS.ProcessVersions & {
    bun?: string | undefined;
  };
  delete nodeVersions.bun;
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: nodeVersions,
  });
  return () => {
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: originalVersions,
    });
  };
}

function createTrustedBundledFixtureRoot(prefix: string): string {
  fs.mkdirSync(trustedBundledFixturesRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(trustedBundledFixturesRoot, `.${prefix}`));
  trustedBundledFixtureDirs.push(rootDir);
  return rootDir;
}

function writePluginPackageJson(pluginDir: string, name = "demo"): void {
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/plugin-${name}`,
    version: "0.0.0",
    type: "module",
  });
}

function createBundledPluginDir(prefix: string, marker: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  const pluginDir = path.join(rootDir, "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginPackageJson(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  return rootDir;
}

function useBundledPluginDirOverrideForTest(dir: string): void {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  setBundledPluginsDirOverrideForTest(dir);
}

function createThrowingPluginDir(prefix: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  const pluginDir = path.join(rootDir, "bad");
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginPackageJson(pluginDir, "bad");
  fs.writeFileSync(
    path.join(pluginDir, "api.js"),
    `throw new Error("plugin load failure");\n`,
    "utf8",
  );
  return rootDir;
}

function createCircularPluginDir(prefix: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  const pluginDir = path.join(rootDir, "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginPackageJson(pluginDir);
  fs.writeFileSync(
    path.join(rootDir, "facade.mjs"),
    [
      `const loadBundledPluginPublicSurfaceModuleSync = globalThis.${FACADE_LOADER_GLOBAL};`,
      `if (typeof loadBundledPluginPublicSurfaceModuleSync !== "function") {`,
      '  throw new Error("missing facade loader test loader");',
      "}",
      `export const marker = loadBundledPluginPublicSurfaceModuleSync({ dirName: "demo", artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "helper.js"),
    ['import { marker } from "../facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return rootDir;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPackagedBundledPluginDirWithStagedRuntimeDep(params: {
  marker: string;
  prefix: string;
}): {
  bundledPluginsDir: string;
  env: NodeJS.ProcessEnv;
  installRoot: string;
  modulePath: string;
  packageRoot: string;
  pluginRoot: string;
  stageRoot: string;
} {
  const packageRoot = path.resolve(".");
  const pluginRoot = path.join(trustedBundledFixturesRoot, "demo");
  const stageRoot = createTempDirSync(`${params.prefix}stage-`);
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: trustedBundledFixturesRoot,
    OPENCLAW_PLUGIN_STAGE_DIR: stageRoot,
  };
  trustedBundledFixtureDirs.push(pluginRoot);
  fs.mkdirSync(pluginRoot, { recursive: true });

  writeJsonFile(path.join(pluginRoot, "package.json"), {
    name: "@openclaw/plugin-demo",
    version: "0.0.0",
    type: "module",
    dependencies: {
      [STAGED_RUNTIME_DEP_NAME]: "1.0.0",
    },
  });
  const modulePath = path.join(pluginRoot, "api.js");
  fs.writeFileSync(
    modulePath,
    [
      `import { marker as depMarker } from ${JSON.stringify(STAGED_RUNTIME_DEP_NAME)};`,
      "export const marker = `facade:${depMarker}`;",
      "export const moduleUrl = import.meta.url;",
      "",
    ].join("\n"),
    "utf8",
  );

  const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
    env,
  });
  const depRoot = path.join(installRoot, "node_modules", STAGED_RUNTIME_DEP_NAME);
  writeJsonFile(path.join(depRoot, "package.json"), {
    name: STAGED_RUNTIME_DEP_NAME,
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  });
  fs.writeFileSync(
    path.join(depRoot, "index.js"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );

  return {
    bundledPluginsDir: trustedBundledFixturesRoot,
    env,
    installRoot,
    modulePath,
    packageRoot,
    pluginRoot,
    stageRoot,
  };
}

beforeEach(() => {
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  delete process.env.OPENCLAW_PLUGIN_STAGE_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of trustedBundledFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  resetFacadeLoaderStateForTest();
  setFacadeLoaderJitiFactoryForTest(undefined);
  setBundledPluginsDirOverrideForTest(undefined);
  clearBundledRuntimeDependencyNodePaths();
  delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL];
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalPluginStageDir === undefined) {
    delete process.env.OPENCLAW_PLUGIN_STAGE_DIR;
  } else {
    process.env.OPENCLAW_PLUGIN_STAGE_DIR = originalPluginStageDir;
  }
});

describe("plugin-sdk facade loader", () => {
  it("honors trusted bundled plugin dir overrides", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-loader-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-loader-b-", "override-b");

    useBundledPluginDirOverrideForTest(overrideA);
    const fromA = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromA.marker).toBe("override-a");

    useBundledPluginDirOverrideForTest(overrideB);
    const fromB = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromB.marker).toBe("override-b");
  });

  it("falls back to package source surfaces when an override dir lacks a bundled plugin", () => {
    const overrideDir = createTrustedBundledFixtureRoot("openclaw-facade-loader-empty-");
    useBundledPluginDirOverrideForTest(overrideDir);

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{
      definePluginEntry: unknown;
    }>({
      dirName: "thread-ownership",
      artifactBasename: "api.js",
    });

    expect(loaded.definePluginEntry).toEqual(expect.any(Function));
  });

  it("keeps bundled facade loads disabled when bundled plugins are disabled", () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      }),
    ).toThrow("Unable to resolve bundled plugin public surface browser/browser-maintenance.js");
  });

  it("shares loaded facade ids with facade-runtime", () => {
    const dir = createBundledPluginDir("openclaw-facade-loader-ids-", "identity-check");
    useBundledPluginDirOverrideForTest(dir);

    const first = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    const second = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(listImportedFacadeRuntimeIds()).toEqual(["demo"]);
  });

  it("uses the runtime-supported Jiti boundary for Windows dist facade loads", () => {
    const bundledPluginsDir = createTrustedBundledFixtureRoot(
      "openclaw-facade-loader-windows-dist-",
    );
    const pluginDir = path.join(bundledPluginsDir, "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    writePluginPackageJson(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "api.js"),
      'export const marker = "windows-dist-ok";\n',
      "utf8",
    );
    useBundledPluginDirOverrideForTest(bundledPluginsDir);

    const createJitiCalls: Parameters<FacadeLoaderJitiFactory>[] = [];
    setFacadeLoaderJitiFactoryForTest(((...args) => {
      createJitiCalls.push(args);
      return vi.fn(() => ({
        marker: "windows-dist-ok",
      })) as unknown as ReturnType<FacadeLoaderJitiFactory>;
    }) as FacadeLoaderJitiFactory);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const restoreVersions = forceNodeRuntimeVersionsForTest();

    try {
      expect(
        loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "api.js",
        }).marker,
      ).toBe("windows-dist-ok");
      expect(createJitiCalls).toHaveLength(1);
      expect(createJitiCalls[0]?.[0]).toEqual(expect.any(String));
      expect(createJitiCalls[0]?.[1]).toEqual(
        expect.objectContaining({
          tryNative: shouldExpectNativeJitiForJavaScriptTestRuntime(),
        }),
      );
    } finally {
      restoreVersions();
      platformSpy.mockRestore();
    }
  });

  it("loads built bundled sync public surfaces through staged runtime deps", async () => {
    const fixture = createPackagedBundledPluginDirWithStagedRuntimeDep({
      marker: "staged",
      prefix: "openclaw-facade-loader-runtime-deps-",
    });
    useBundledPluginDirOverrideForTest(fixture.bundledPluginsDir);
    process.env.OPENCLAW_PLUGIN_STAGE_DIR = fixture.stageRoot;

    await expect(import(pathToFileURL(fixture.modulePath).href)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{
      marker: string;
      moduleUrl: string;
    }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("facade:staged");
    expect(fs.existsSync(path.join(fixture.pluginRoot, "node_modules"))).toBe(false);
    expect(fs.realpathSync(fileURLToPath(loaded.moduleUrl))).toBe(
      fs.realpathSync(
        path.join(fixture.installRoot, "dist-runtime", "extensions", "demo", "api.js"),
      ),
    );
  });

  it("loads built bundled async public surfaces through staged runtime deps", async () => {
    const fixture = createPackagedBundledPluginDirWithStagedRuntimeDep({
      marker: "staged",
      prefix: "openclaw-facade-loader-built-async-",
    });
    setBundledPluginsDirOverrideForTest(fixture.bundledPluginsDir);

    const loaded = await loadBundledPluginPublicSurfaceModule<{
      marker: string;
      moduleUrl: string;
    }>({
      dirName: "demo",
      artifactBasename: "api.js",
      env: fixture.env,
    });

    expect(loaded.marker).toBe("facade:staged");
    expect(fs.realpathSync(fileURLToPath(loaded.moduleUrl))).toBe(
      fs.realpathSync(
        path.join(fixture.installRoot, "dist-runtime", "extensions", "demo", "api.js"),
      ),
    );
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createCircularPluginDir("openclaw-facade-loader-circular-");
    useBundledPluginDirOverrideForTest(dir);
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSync;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
  });

  it("clears the cache on load failure so retries re-execute", () => {
    const dir = createThrowingPluginDir("openclaw-facade-loader-throw-");
    useBundledPluginDirOverrideForTest(dir);

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");
  });
});
