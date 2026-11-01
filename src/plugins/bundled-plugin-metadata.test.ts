import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it } from "vitest";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { resolveBundledPluginGeneratedPath } from "./bundled-plugin-scan.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-ids.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  pluginTestRepoRoot as repoRoot,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry-build.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeBundledRuntimeSidecarPathBaseline } from "./runtime-sidecar-paths-baseline.js";

// llama-cpp starts for its enabled local_image tool factory, not a startup sidecar.
const EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_EXTRAS = ["llama-cpp", "memory-core", "xai"] as const;

installGeneratedPluginTempRootCleanup();

beforeEach(clearPluginMetadataLifecycleCaches);

function expectGeneratedPathResolution(tempRoot: string, expectedRelativePath: string) {
  expect(
    resolveBundledPluginGeneratedPath(tempRoot, {
      source: "./plugin/index.ts",
      built: "plugin/index.js",
    }),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

function writeAlphaPlugin(pluginRoot: string, manifest: Record<string, unknown>) {
  writeJson(path.join(pluginRoot, "package.json"), {
    name: "@openclaw/alpha",
    version: "0.0.1",
    openclaw: { extensions: ["./index.ts"] },
  });
  writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: "alpha",
    configSchema: { type: "object" },
    ...manifest,
  });
  writeEntry(pluginRoot, "index.ts");
}

function writeEntry(root: string, relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export {};\n", "utf8");
  return file;
}

function collectRepoBundledChannelConfigsForTest(dirName: string) {
  const metadata = listBundledPluginMetadata({
    rootDir: repoRoot,
    includeChannelConfigs: false,
  }).find((entry) => entry.dirName === dirName);
  assert(metadata, `missing bundled plugin ${dirName}`);
  return collectBundledChannelConfigsCore({
    pluginDir: path.join(repoRoot, "extensions", dirName),
    manifest: metadata.manifest,
    packageManifest: metadata.packageManifest,
  });
}

function createRepoBundledManifestRegistry(): PluginManifestRegistry {
  return loadBundledPluginManifestRegistry({
    env: {},
    bundledRoot: path.join(repoRoot, "extensions"),
  });
}

function createInstalledPluginIndexForManifests(manifestRegistry: PluginManifestRegistry) {
  const index = createInstalledPluginIndexFixture(manifestRegistry);
  index.plugins = index.plugins.map((plugin, i) => ({
    ...plugin,
    packageBuild: undefined,
    enabledByDefaultOnPlatforms: manifestRegistry.plugins[i]!.enabledByDefaultOnPlatforms,
    enabled: plugin.enabledByDefault === true,
  }));
  return index;
}

describe("bundled plugin metadata", () => {
  it("matches the checked-in runtime sidecar path baseline", { timeout: 300_000 }, () =>
    expect(
      writeBundledRuntimeSidecarPathBaseline({ repoRoot, check: true }),
    ).resolves.toMatchObject({ changed: false }),
  );

  it("captures setup-entry metadata for bundled channel plugins", () => {
    const discord = listBundledPluginMetadata({
      rootDir: repoRoot,
      includeSyntheticChannelConfigs: false,
    }).find((entry) => entry.dirName === "discord");
    expect(discord).toMatchObject({
      source: { source: "./index.ts", built: "index.js" },
      setupSource: { source: "./setup-entry.ts", built: "setup-entry.js" },
      publicSurfaceArtifacts: expect.arrayContaining([
        "api.js",
        "runtime-api.js",
        "session-key-api.js",
      ]),
      runtimeSidecarArtifacts: expect.arrayContaining(["runtime-api.js"]),
      manifest: { id: "discord" },
    });
    expect(discord?.publicSurfaceArtifacts).not.toContain("test-api.js");
    expect(collectRepoBundledChannelConfigsForTest("discord")?.discord).toMatchObject({
      schema: { type: "object" },
    });
  });

  it("loads tlon channel config metadata from the lightweight schema surface", () => {
    expect(collectRepoBundledChannelConfigsForTest("tlon")?.tlon).toMatchObject({
      schema: { type: "object" },
    });
  });

  it("keeps empty-config Gateway startup narrower than declared startup sidecars", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const linuxOnlyPlugin = manifestRegistry.plugins[0];
    assert(linuxOnlyPlugin, "expected bundled plugin manifest fixture");
    manifestRegistry.plugins.push({
      ...linuxOnlyPlugin,
      id: "zz-linux-only-default-test",
      enabledByDefault: undefined,
      enabledByDefaultOnPlatforms: ["linux"],
      activation: { ...linuxOnlyPlugin.activation, onStartup: true },
    });
    const index = createInstalledPluginIndexForManifests(manifestRegistry);
    const expectedPluginIds = [
      ...manifestRegistry.plugins
        .filter(
          (plugin) =>
            isPluginEnabledByDefaultForPlatform(plugin, "linux") && plugin.activation?.onStartup,
        )
        .map((plugin) => plugin.id),
      ...EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_EXTRAS,
    ].toSorted((left, right) => left.localeCompare(right));

    expect(expectedPluginIds).not.toContain("slack-huddles");
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config: {},
        env: {},
        index,
        manifestRegistry,
        platform: "linux",
      }).pluginIds,
    ).toEqual(expectedPluginIds);
  });

  it.each([
    { name: "before login", config: {} },
    {
      name: "with only an OpenAI login and chat model",
      config: {
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" as const } } },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: { "openai/gpt-5.6-sol": {} },
          },
        },
      },
    },
  ])("starts the OpenAI browser broker $name without Talk configuration", ({ config }) => {
    const manifestRegistry = createRepoBundledManifestRegistry();

    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: {},
        index: createInstalledPluginIndexForManifests(manifestRegistry),
        manifestRegistry,
      }).pluginIds,
    ).toContain("openai");
  });

  it("prefers built generated paths when present and falls back to source paths", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-metadata-");
    const pluginRoot = path.join(tempRoot, "extensions", "plugin");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "plugin");

    writeEntry(pluginRoot, "index.ts");
    expectGeneratedPathResolution(tempRoot, path.join("extensions", "plugin", "index.ts"));

    writeEntry(distPluginRoot, "index.js");
    expectGeneratedPathResolution(tempRoot, path.join("dist", "extensions", "plugin", "index.js"));
  });

  it("keeps generated entry path resolution inside bundled plugin roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-path-contained-");
    const sourcePluginRoot = path.join(tempRoot, "extensions", "alpha");
    const absoluteEscape = writeEntry(tempRoot, "absolute.js");
    const absolutePluginEntry = writeEntry(sourcePluginRoot, "index.ts");
    fs.mkdirSync(path.join(tempRoot, "dist", "extensions", "alpha"), { recursive: true });
    writeEntry(tempRoot, "extensions/escape.ts");
    writeEntry(tempRoot, "dist/extensions/escape.js");

    const resolve = (source: string, built = source) =>
      resolveBundledPluginGeneratedPath(tempRoot, { source, built }, "alpha");
    expect(resolve(absolutePluginEntry)).toBe(absolutePluginEntry);
    expect(resolve("../escape.ts", "../escape.js")).toBeNull();
    expect(resolve(absoluteEscape)).toBeNull();
  });

  it("scans direct plugin-tree overrides and resolves generated paths from that scan dir", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-tree-");
    const pluginsDir = path.join(tempRoot, "bundled-plugins");
    const pluginRoot = path.join(pluginsDir, "alpha");

    writeAlphaPlugin(pluginRoot, { channels: ["alpha"] });
    writeEntry(tempRoot, "dist/extensions/alpha/index.js");
    expect(
      listBundledPluginMetadata({
        rootDir: tempRoot,
        scanDir: pluginsDir,
      }).map((entry) => entry.manifest.id),
    ).toEqual(["alpha"]);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "alpha",
        pluginsDir,
      ),
    ).toBe(path.join(pluginRoot, "index.ts"));
  });

  it("reflects bundled manifest edits in the next lifecycle generation", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-fresh-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");

    writeAlphaPlugin(pluginRoot, { name: "Before" });

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("Before");

    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "After",
      configSchema: { type: "object" },
    });
    clearPluginMetadataLifecycleCaches();

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("After");
  });
});
