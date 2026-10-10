// Facade runtime tests cover installed plugin facade loading and fallback resolution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makeEmptyPluginMetadataOwners,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";
import { captureEnv } from "../test-utils/env.js";
import * as facadeActivationRuntime from "./facade-activation-check.runtime.js";
import { resolveBundledPluginPublicSurfaceAccess as resolveActivationCheckBundledPluginPublicSurfaceAccess } from "./facade-activation-check.runtime.js";
import {
  testing,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_STATE_DIR",
]);
const trustedBundledFixturesRoot = path.resolve("dist-runtime", "extensions");
const trustedBundledFixtureDirs: string[] = [];
type SnapshotPluginRecord = PluginMetadataSnapshot["manifestRegistry"]["plugins"][number];

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeInstalledRuntimeFacadeFixture(
  rootDir: string,
  params: { pluginId: string; channelId: string; marker: string },
): void {
  const modulePath = path.join(rootDir, "runtime-api.js");
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, `export const marker = ${JSON.stringify(params.marker)};\n`, "utf8");
  writeJsonFile(path.join(rootDir, "package.json"), {
    name: `@openclaw/${params.pluginId}`,
    version: "0.0.0",
    openclaw: {
      extensions: ["./runtime-api.js"],
      channel: { id: params.channelId },
    },
  });
  writeJsonFile(path.join(rootDir, "openclaw.plugin.json"), {
    id: params.pluginId,
    channels: [params.channelId],
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
}

function createTrustedBundledFixtureRoot(prefix: string): string {
  fs.mkdirSync(trustedBundledFixturesRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(trustedBundledFixturesRoot, `.${prefix}`));
  trustedBundledFixtureDirs.push(rootDir);
  return rootDir;
}

function writePluginPackageJson(
  pluginDir: string,
  name = "demo",
  type: "commonjs" | "module" = "module",
): void {
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/plugin-${name}`,
    version: "0.0.0",
    type,
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

describe("plugin-sdk facade runtime", () => {
  it("refreshes browser SDK surfaces only when the plugin cache generation changes", async () => {
    const dir = createTrustedBundledFixtureRoot("openclaw-browser-generation-");
    const pluginDir = path.join(dir, "browser");
    writePluginPackageJson(pluginDir, "browser", "commonjs");
    writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "browser",
      enabledByDefault: true,
    });
    useBundledPluginDirOverrideForTest(dir);
    setRuntimeConfigSnapshot({});
    testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);
    const auth = await import("./browser-control-auth.js");
    const profiles = await import("./browser-profiles.js");
    const maintenance = await import("./browser-maintenance.js");
    const writeSurfaces = (generation: number) => {
      fs.writeFileSync(
        path.join(pluginDir, "browser-control-auth.js"),
        `exports.resolveBrowserControlAuth = () => ({ token: "fixture-${generation}" });\n`,
      );
      fs.writeFileSync(
        path.join(pluginDir, "browser-profiles.js"),
        `exports.resolveBrowserConfig = () => ({ defaultProfile: "fixture-${generation}" });\n`,
      );
      fs.writeFileSync(
        path.join(pluginDir, "browser-maintenance.js"),
        `exports.closeTrackedBrowserTabsForSessions = async () => ${generation};\n`,
      );
    };
    const readSurfaces = async () => [
      auth.resolveBrowserControlAuth().token,
      profiles.resolveBrowserConfig(undefined).defaultProfile,
      await maintenance.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:fixture-session"],
      }),
    ];

    writeSurfaces(1);
    expect(await readSurfaces()).toEqual(["fixture-1", "fixture-1", 1]);
    writeSurfaces(2);
    expect(await readSurfaces()).toEqual(["fixture-1", "fixture-1", 1]);

    clearPluginMetadataLifecycleCaches();
    testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);

    expect(await readSurfaces()).toEqual(["fixture-2", "fixture-2", 2]);
    setRuntimeConfigSnapshot({ plugins: { entries: { browser: { enabled: false } } } });
    expect(
      await maintenance.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:fixture-session"],
      }),
    ).toBe(0);
  });

  it("does not reuse enabled facade locations when bundled plugins are disabled", () => {
    const dir = createBundledPluginDir("openclaw-facade-location-disabled-", "enabled");
    useBundledPluginDirOverrideForTest(dir);
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
    const profileA: NodeJS.ProcessEnv = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(path.sep, "openclaw-facade-profile-a"),
    };
    const profileB: NodeJS.ProcessEnv = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(path.sep, "openclaw-facade-profile-b"),
    };
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
    const profileARoot = path.join(profileA.OPENCLAW_STATE_DIR!, "plugins", "demo");
    const profileBRoot = path.join(profileB.OPENCLAW_STATE_DIR!, "plugins", "demo");

    expect(testing.resolveFacadeModuleLocation({ ...params, env: profileA })).toEqual({
      modulePath: path.join(profileARoot, "api.js"),
      boundaryRoot: profileARoot,
    });
    expect(testing.resolveFacadeModuleLocation({ ...params, env: profileB })).toEqual({
      modulePath: path.join(profileBRoot, "api.js"),
      boundaryRoot: profileBRoot,
    });
    expect(resolveRegistryPluginModuleLocation).toHaveBeenCalledTimes(2);
    expect(resolveRegistryPluginModuleLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ env: profileA }),
    );
    expect(resolveRegistryPluginModuleLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ env: profileB }),
    );
  });

  it("memoizes missing facade locations until the plugin lifecycle clears", () => {
    const dir = createTrustedBundledFixtureRoot("openclaw-facade-location-retry-");
    useBundledPluginDirOverrideForTest(dir);
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
    // Plugin topology is process-stable: repeated lookups for a missing plugin
    // must not re-walk the filesystem or registry on every request.
    expect(testing.resolveFacadeModuleLocation(params)).toBeNull();
    expect(registryProbes).toBe(1);

    const pluginDir = path.join(dir, params.dirName);
    fs.mkdirSync(pluginDir, { recursive: true });
    writePluginPackageJson(pluginDir, params.dirName);
    fs.writeFileSync(path.join(pluginDir, "api.js"), 'export const marker = "ready";\n', "utf8");

    // Install/reload flows clear the metadata lifecycle memo; only then does
    // the new artifact become visible.
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
    const unexpectedReentryMarkers = reentryMarkers.filter((marker) => marker !== "post-load-ok");
    expect(unexpectedReentryMarkers).toStrictEqual([]);
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("loads a disabled-by-default facade only while it is explicitly enabled", () => {
    const dir = createTrustedBundledFixtureRoot("openclaw-facade-runtime-enabled-");
    const pluginDir = path.join(dir, "fixture");
    writePluginPackageJson(pluginDir, "fixture", "commonjs");
    writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "fixture",
      enabledByDefault: false,
    });
    fs.writeFileSync(
      path.join(pluginDir, "runtime-api.js"),
      'exports.marker = "runtime-api-enabled";\n',
    );
    useBundledPluginDirOverrideForTest(dir);
    testing.setFacadeActivationCheckRuntimeForTest(facadeActivationRuntime);
    const load = () =>
      loadActivatedBundledPluginPublicSurfaceModuleSync({
        dirName: "fixture",
        artifactBasename: "runtime-api.js",
      });

    setRuntimeConfigSnapshot({});
    expect(load).toThrow(/Bundled plugin public surface access blocked.*disabled by default/);
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    setRuntimeConfigSnapshot({}, { plugins: { entries: { fixture: { enabled: true } } } });
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

    // Installed roots are outside the package/bundled roots, so the facade
    // boundary open applies shouldRejectHardlinkedPluginFiles (nlink > 1 fails).
    expect(() =>
      testing.loadFacadeModuleAtLocationSync({
        location: { modulePath: artifactPath, boundaryRoot: installedDir },
        trackedPluginId: "line",
      }),
    ).toThrow(`Unable to open bundled plugin public surface ${artifactPath}`);
  });

  it("resolves a globally-installed plugin whose rootDir basename matches the dirName", () => {
    const lineDir = path.join(createTempDirSync("openclaw-facade-global-line-"), "line");
    writeInstalledRuntimeFacadeFixture(lineDir, {
      pluginId: "line-owner",
      channelId: "other-line-channel",
      marker: "global-line",
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

  it("keeps the bundled extension runtime-core facade available without plugin activation", () => {
    setRuntimeConfigSnapshot({});

    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName: "image-generation-core",
        artifactBasename: "runtime-api.js",
        location: null,
        sourceExtensionsRoot: "",
      }),
    ).toEqual({
      allowed: true,
      pluginId: "image-generation-core",
    });
  });

  it("does not treat the core-owned speech runtime as a bundled extension facade", () => {
    setRuntimeConfigSnapshot({});

    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName: "speech-core",
        artifactBasename: "runtime-api.js",
        location: null,
        sourceExtensionsRoot: "",
      }),
    ).toEqual({
      allowed: false,
      reason: "no bundled plugin manifest found for speech-core",
    });
  });

  it("validates current snapshot against facade boundary config and ignores on mismatch", () => {
    const dir = createTempDirSync("openclaw-facade-snapshot-validate-");
    fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "demo", "runtime-api.js"),
      'export const marker = "snapshot-validate";\n',
      "utf8",
    );
    // Do NOT write openclaw.plugin.json on disk to force fallback to registry scan
    useBundledPluginDirOverrideForTest(dir);

    function createTestSnapshot(
      params: {
        config?: OpenClawConfig;
        plugins?: SnapshotPluginRecord[];
      } = {},
    ): PluginMetadataSnapshot {
      const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
      const index: PluginMetadataSnapshot["index"] = {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash,
        generatedAtMs: 1,
        installRecords: {},
        plugins: [],
        diagnostics: [],
      };
      return {
        policyHash,
        index,
        registryIndex: index,
        registryDiagnostics: [],
        manifestRegistry: { plugins: params.plugins ?? [], diagnostics: [] },
        plugins: [],
        diagnostics: [],
        byPluginId: new Map(),
        normalizePluginId: (pluginId) => pluginId,
        declaredProviderOwners: buildDeclaredProviderOwnerIndex(params.plugins ?? []),
        owners: makeEmptyPluginMetadataOwners(),
        metrics: {
          registrySnapshotMs: 0,
          manifestRegistryMs: 0,
          ownerMapsMs: 0,
          totalMs: 0,
          indexPluginCount: 0,
          manifestPluginCount: 0,
        },
      };
    }

    const configWithPaths = {
      plugins: {
        load: { paths: ["/path/one"] },
        entries: {
          "demo-snapshot": { enabled: true },
          demo: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const matchedSnapshot = createTestSnapshot({
      config: configWithPaths,
      plugins: [
        {
          id: "demo-snapshot",
          rootDir: path.join(dir, "demo"),
          source: path.join(dir, "demo", "runtime-api.js"),
          manifestPath: path.join(dir, "demo", "openclaw.plugin.json"),
          channels: ["demo"],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled" as const,
        },
      ],
    });

    setCurrentPluginMetadataSnapshot(matchedSnapshot, { config: configWithPaths });

    setRuntimeConfigSnapshot(
      {
        plugins: {
          load: { paths: ["/path/two"] },
          entries: {
            "demo-snapshot": { enabled: true },
            demo: { enabled: true },
          },
        },
      },
      {
        plugins: {
          load: { paths: ["/path/two"] },
          entries: {
            "demo-snapshot": { enabled: true },
            demo: { enabled: true },
          },
        },
      },
    );

    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName: "demo",
        artifactBasename: "runtime-api.js",
        location: null,
        sourceExtensionsRoot: dir,
      }),
    ).toEqual({
      allowed: false,
      reason: "no bundled plugin manifest found for demo",
    });

    setRuntimeConfigSnapshot(configWithPaths, configWithPaths);

    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName: "demo",
        artifactBasename: "runtime-api.js",
        location: null,
        sourceExtensionsRoot: dir,
      }),
    ).toEqual({
      allowed: true,
      pluginId: "demo-snapshot",
    });
  });
});
