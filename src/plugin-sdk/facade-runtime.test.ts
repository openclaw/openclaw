import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { captureEnv } from "../test-utils/env.js";
import * as facadeActivationRuntime from "./facade-activation-check.runtime.js";
import { resolveBundledPluginPublicSurfaceAccess as resolveActivationCheckBundledPluginPublicSurfaceAccess } from "./facade-activation-check.runtime.js";
import {
  testing,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { writeFacadeFiles } from "./facade-runtime.test-support.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_STATE_DIR",
]);
const trustedBundledFixturesRoot = path.resolve("dist-runtime", "extensions");
const trustedBundledFixtureDirs: string[] = [];

function createTrustedBundledFixtureRoot(prefix: string): string {
  fs.mkdirSync(trustedBundledFixturesRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(trustedBundledFixturesRoot, `.${prefix}`));
  trustedBundledFixtureDirs.push(rootDir);
  return rootDir;
}

function createBundledPluginDir(prefix: string, marker: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  writeFacadeFiles(path.join(rootDir, "demo"), {
    "package.json": { type: "module" },
    "api.js": `export const marker = ${JSON.stringify(marker)};`,
  });
  return rootDir;
}

beforeEach(() => {
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  delete process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of trustedBundledFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetFacadeRuntimeStateForTest();
  vi.doUnmock("../plugins/manifest-registry.js");
  originalEnv.restore();
});

it("refreshes browser SDK surfaces only when the plugin cache generation changes", async () => {
  const dir = createTrustedBundledFixtureRoot("openclaw-browser-generation-");
  const pluginDir = writeFacadeFiles(path.join(dir, "browser"), {
    "package.json": { type: "commonjs" },
    "openclaw.plugin.json": { id: "browser", enabledByDefault: true },
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  setRuntimeConfigSnapshot({});
  testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);
  const auth = await import("./browser-control-auth.js");
  const profiles = await import("./browser-profiles.js");
  const maintenance = await import("./browser-maintenance.js");
  const writeSurfaces = (generation: number) =>
    writeFacadeFiles(pluginDir, {
      "browser-control-auth.js": `exports.resolveBrowserControlAuth = () => ({ token: "fixture-${generation}" });`,
      "browser-profiles.js": `exports.resolveBrowserConfig = () => ({ defaultProfile: "fixture-${generation}" });`,
      "browser-maintenance.js": `exports.closeTrackedBrowserTabsForSessions = async () => ${generation};`,
    });
  const session = { sessionKeys: ["agent:main:fixture-session"] };
  const readSurfaces = async () => [
    auth.resolveBrowserControlAuth().token,
    profiles.resolveBrowserConfig(undefined).defaultProfile,
    await maintenance.closeTrackedBrowserTabsForSessions(session),
  ];

  writeSurfaces(1);
  expect(await readSurfaces()).toEqual(["fixture-1", "fixture-1", 1]);
  writeSurfaces(2);
  expect(await readSurfaces()).toEqual(["fixture-1", "fixture-1", 1]);

  clearPluginMetadataLifecycleCaches();
  testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);

  expect(await readSurfaces()).toEqual(["fixture-2", "fixture-2", 2]);
  setRuntimeConfigSnapshot({ plugins: { entries: { browser: { enabled: false } } } });
  expect(await maintenance.closeTrackedBrowserTabsForSessions(session)).toBe(0);
});

it("does not reuse enabled facade locations when bundled plugins are disabled", () => {
  const dir = createBundledPluginDir("openclaw-facade-location-disabled-", "enabled");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  const params = {
    dirName: "demo",
    artifactBasename: "api.js",
  };

  expect(testing.resolveFacadeModuleLocation(params)).toEqual({
    modulePath: path.join(dir, "demo", "api.js"),
    origin: "bundled",
    boundaryRoot: dir,
  });

  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  testing.setFacadeActivationCheckRuntimeForTest({
    resolveRegistryPluginModuleLocation: () => null,
  } as never);

  expect(testing.resolveFacadeModuleLocation(params)).toBeNull();
});

it("does not reuse installed facade locations across custom environment profiles", () => {
  const profiles = ["a", "b"].map((id): NodeJS.ProcessEnv => ({
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(path.sep, `openclaw-facade-profile-${id}`),
  }));
  const resolveRegistryPluginModuleLocation = vi.fn(({ env }: { env?: NodeJS.ProcessEnv }) => {
    const stateDir = env?.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      return null;
    }
    const boundaryRoot = path.join(stateDir, "plugins", "demo");
    return {
      modulePath: path.join(boundaryRoot, "api.js"),
      boundaryRoot,
    };
  });
  testing.setFacadeActivationCheckRuntimeForTest({
    resolveRegistryPluginModuleLocation,
  } as never);

  const params = { dirName: "demo", artifactBasename: "api.js" };
  for (const [index, env] of profiles.entries()) {
    const boundaryRoot = path.join(env.OPENCLAW_STATE_DIR!, "plugins", "demo");
    expect(testing.resolveFacadeModuleLocation({ ...params, env })).toEqual({
      modulePath: path.join(boundaryRoot, "api.js"),
      boundaryRoot,
    });
    expect(resolveRegistryPluginModuleLocation).toHaveBeenNthCalledWith(
      index + 1,
      expect.objectContaining({ env }),
    );
  }
  expect(resolveRegistryPluginModuleLocation).toHaveBeenCalledTimes(2);
});

it("memoizes missing facade locations until the plugin lifecycle clears", () => {
  const dir = createTrustedBundledFixtureRoot("openclaw-facade-location-retry-");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  let registryProbes = 0;
  testing.setFacadeActivationCheckRuntimeForTest({
    resolveRegistryPluginModuleLocation: () => {
      registryProbes += 1;
      return null;
    },
  } as never);
  const params = {
    dirName: "future-demo",
    artifactBasename: "api.js",
  };

  expect(testing.resolveFacadeModuleLocation(params)).toBeNull();
  expect(testing.resolveFacadeModuleLocation(params)).toBeNull();
  expect(registryProbes).toBe(1);

  const pluginDir = path.join(dir, params.dirName);
  writeFacadeFiles(pluginDir, {
    "package.json": { type: "module" },
    "api.js": 'export const marker = "ready";',
  });

  expect(testing.resolveFacadeModuleLocation(params)).toBeNull();
  clearPluginMetadataLifecycleCaches();

  expect(testing.resolveFacadeModuleLocation(params)).toEqual({
    modulePath: path.join(pluginDir, "api.js"),
    origin: "bundled",
    boundaryRoot: dir,
  });
});

it("back-fills the sentinel before post-load facade tracking re-enters", () => {
  const dir = createBundledPluginDir("openclaw-facade-post-load-", "post-load-ok");
  const location = {
    modulePath: path.join(dir, "demo", "api.js"),
    boundaryRoot: dir,
  };
  const reentryMarkers: Array<string | undefined> = [];
  const loader = vi.fn(() => ({ marker: "post-load-ok" }));

  const loaded = testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
    location,
    trackedPluginId: () => {
      const reentered = testing.loadFacadeModuleAtLocationSync<{ marker?: string }>({
        location,
        trackedPluginId: "demo",
        loadModule: loader,
      });
      reentryMarkers.push(reentered.marker);
      return "demo";
    },
    loadModule: loader,
  });

  expect(loaded.marker).toBe("post-load-ok");
  expect(reentryMarkers.length).toBeGreaterThan(0);
  expect(reentryMarkers.filter((marker) => marker !== "post-load-ok")).toStrictEqual([]);
  expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
  expect(loader).toHaveBeenCalledTimes(1);
});

it("loads a disabled-by-default facade only while it is explicitly enabled", () => {
  const dir = createTrustedBundledFixtureRoot("openclaw-facade-runtime-enabled-");
  writeFacadeFiles(path.join(dir, "fixture"), {
    "package.json": { type: "commonjs" },
    "openclaw.plugin.json": { id: "fixture", enabledByDefault: false },
    "runtime-api.js": 'exports.marker = "runtime-api-enabled";',
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);
  const load = () =>
    loadActivatedBundledPluginPublicSurfaceModuleSync({
      dirName: "fixture",
      artifactBasename: "runtime-api.js",
    });

  setRuntimeConfigSnapshot({});
  expect(load).toThrow(/Bundled plugin public surface access blocked.*disabled by default/);
  expect(listImportedBundledPluginFacadeIds()).toEqual([]);

  const enabledConfig = { plugins: { entries: { fixture: { enabled: true } } } };
  setRuntimeConfigSnapshot(enabledConfig, enabledConfig);
  expect(load()).toEqual({ marker: "runtime-api-enabled" });
  expect(listImportedBundledPluginFacadeIds()).toEqual(["fixture"]);

  setRuntimeConfigSnapshot({ plugins: { entries: { fixture: { enabled: false } } } });
  expect(load).toThrow(/Bundled plugin public surface access blocked.*disabled in config/);
});

it("rejects hardlinked artifacts under installed plugin roots", () => {
  const installedDir = createTempDirSync("openclaw-facade-hardlink-");
  const originalPath = path.join(installedDir, "original.js");
  fs.writeFileSync(originalPath, 'export const marker = "hardlinked";\n', "utf8");
  const artifactPath = path.join(installedDir, "runtime-api.js");
  fs.linkSync(originalPath, artifactPath);

  expect(() =>
    testing.loadFacadeModuleAtLocationSync({
      location: { modulePath: artifactPath, boundaryRoot: installedDir },
      trackedPluginId: "line",
    }),
  ).toThrow(`Unable to open bundled plugin public surface ${artifactPath}`);
});

it("resolves a globally-installed plugin whose rootDir basename matches the dirName", () => {
  const lineDir = path.join(createTempDirSync("openclaw-facade-global-line-"), "line");
  writeFacadeFiles(lineDir, {
    "runtime-api.js": 'export const marker = "global-line";',
  });

  expect(
    testing.resolveRegistryPluginModuleLocationFromRegistry({
      registry: [
        {
          id: "line-owner",
          rootDir: lineDir,
          channels: ["other-line-channel"],
        },
      ],
      dirName: "line",
      artifactBasename: "runtime-api.js",
    }),
  ).toEqual({
    modulePath: path.join(lineDir, "runtime-api.js"),
    boundaryRoot: lineDir,
  });
});

it.each([
  ["image-generation-core", { allowed: true, pluginId: "image-generation-core" }],
  ["speech-core", { allowed: false, reason: "no bundled plugin manifest found for speech-core" }],
] as const)(
  "applies runtime-core activation exemption only to bundled extensions: %s",
  (dirName, access) => {
    setRuntimeConfigSnapshot({});
    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName,
        artifactBasename: "runtime-api.js",
        location: null,
        sourceExtensionsRoot: "",
      }),
    ).toEqual(access);
  },
);

it("validates current snapshot against facade boundary config and ignores on mismatch", () => {
  const dir = createTempDirSync("openclaw-facade-snapshot-validate-");
  writeFacadeFiles(path.join(dir, "demo"), {
    "runtime-api.js": 'export const marker = "snapshot-validate";',
  });
  // Do NOT write openclaw.plugin.json on disk to force fallback to registry scan
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

  const configWithPaths = {
    plugins: {
      load: { paths: ["/path/one"] },
      entries: {
        "demo-snapshot": { enabled: true },
        demo: { enabled: true },
      },
    },
  } satisfies OpenClawConfig;
  const matchedSnapshot = createEmptyPluginMetadataSnapshot();
  matchedSnapshot.policyHash = resolveInstalledPluginIndexPolicyHash(configWithPaths);
  matchedSnapshot.index.policyHash = matchedSnapshot.policyHash;
  matchedSnapshot.manifestRegistry.plugins.push(
    createPluginManifestRecordFixture({
      id: "demo-snapshot",
      rootDir: path.join(dir, "demo"),
      source: path.join(dir, "demo", "runtime-api.js"),
      channels: ["demo"],
    }),
  );

  setCurrentPluginMetadataSnapshot(matchedSnapshot, { config: configWithPaths });

  const mismatchedConfig = {
    plugins: { ...configWithPaths.plugins, load: { paths: ["/path/two"] } },
  };
  setRuntimeConfigSnapshot(mismatchedConfig, mismatchedConfig);

  const resolveAccess = () =>
    resolveActivationCheckBundledPluginPublicSurfaceAccess({
      dirName: "demo",
      artifactBasename: "runtime-api.js",
      location: null,
      sourceExtensionsRoot: dir,
    });

  expect(resolveAccess()).toEqual({
    allowed: false,
    reason: "no bundled plugin manifest found for demo",
  });

  setRuntimeConfigSnapshot(configWithPaths, configWithPaths);

  expect(resolveAccess()).toEqual({
    allowed: true,
    pluginId: "demo-snapshot",
  });
});
