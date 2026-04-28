import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBundledRuntimeDependencyNodePaths,
  resolveBundledRuntimeDependencyInstallRoot,
} from "../plugins/bundled-runtime-deps.js";
import { shouldExpectNativeJitiForJavaScriptTestRuntime } from "../test-utils/jiti-runtime.js";
import {
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeLoaderStateForTest,
  setFacadeLoaderJitiFactoryForTest,
} from "./facade-loader.js";
import { listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds } from "./facade-runtime.js";
import {
  createBundledPluginPublicSurfaceFixture,
  createPluginSdkTestHarness,
  createThrowingBundledPluginPublicSurfaceFixture,
} from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalPluginStageDir = process.env.OPENCLAW_PLUGIN_STAGE_DIR;
const FACADE_LOADER_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";
type FacadeLoaderJitiFactory = NonNullable<Parameters<typeof setFacadeLoaderJitiFactoryForTest>[0]>;

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

function createBundledPluginDir(prefix: string, marker: string): string {
  return createBundledPluginPublicSurfaceFixture({ createTempDirSync, marker, prefix });
}

function createThrowingPluginDir(prefix: string): string {
  return createThrowingBundledPluginPublicSurfaceFixture({ createTempDirSync, prefix });
}

function createCircularPluginDir(prefix: string): string {
  const rootDir = createTempDirSync(prefix);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
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
    path.join(rootDir, "demo", "helper.js"),
    ['import { marker } from "../facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return rootDir;
}

function createPackagedBundledPluginDirWithStagedRuntimeDep(prefix: string): {
  bundledPluginsDir: string;
  packageRoot: string;
  pluginRoot: string;
  stageRoot: string;
} {
  const packageRoot = createTempDirSync(prefix);
  const pluginRoot = path.join(packageRoot, "dist", "extensions", "demo");
  const stageRoot = path.join(packageRoot, "stage");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0", type: "module" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/plugin-demo",
        version: "0.0.0",
        type: "module",
        dependencies: {
          "facade-runtime-dep": "1.0.0",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    [
      'import { marker as depMarker } from "facade-runtime-dep";',
      "export const marker = `facade:${depMarker}`;",
      "",
    ].join("\n"),
    "utf8",
  );

  const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
    env: {
      ...process.env,
      OPENCLAW_PLUGIN_STAGE_DIR: stageRoot,
    },
  });
  const depRoot = path.join(installRoot, "node_modules", "facade-runtime-dep");
  fs.mkdirSync(depRoot, { recursive: true });
  fs.writeFileSync(
    path.join(depRoot, "package.json"),
    JSON.stringify(
      { name: "facade-runtime-dep", version: "1.0.0", type: "module", exports: "./index.js" },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(depRoot, "index.js"), 'export const marker = "staged";\n', "utf8");

  return {
    bundledPluginsDir: path.join(packageRoot, "dist", "extensions"),
    packageRoot,
    pluginRoot,
    stageRoot,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFacadeLoaderStateForTest();
  setFacadeLoaderJitiFactoryForTest(undefined);
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
  it("honors bundled plugin dir overrides outside the package root", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-loader-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-loader-b-", "override-b");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideA;
    const fromA = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromA.marker).toBe("override-a");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideB;
    const fromB = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromB.marker).toBe("override-b");
  });

  it("falls back to package source surfaces when an override dir lacks a bundled plugin", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = createTempDirSync("openclaw-facade-loader-empty-");

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{
      closeTrackedBrowserTabsForSessions: unknown;
    }>({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });

    expect(loaded.closeTrackedBrowserTabsForSessions).toEqual(expect.any(Function));
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
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

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
    const dir = createTempDirSync("openclaw-facade-loader-windows-dist-");
    const bundledPluginsDir = path.join(dir, "dist");
    fs.mkdirSync(path.join(bundledPluginsDir, "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(bundledPluginsDir, "demo", "api.js"),
      'export const marker = "windows-dist-ok";\n',
      "utf8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

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

  it("loads built bundled public surfaces through staged runtime deps", () => {
    const fixture = createPackagedBundledPluginDirWithStagedRuntimeDep(
      "openclaw-facade-loader-runtime-deps-",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;
    process.env.OPENCLAW_PLUGIN_STAGE_DIR = fixture.stageRoot;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("facade:staged");
    expect(fs.existsSync(path.join(fixture.pluginRoot, "node_modules"))).toBe(false);
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createCircularPluginDir("openclaw-facade-loader-circular-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
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
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

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
