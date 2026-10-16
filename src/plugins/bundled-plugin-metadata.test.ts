// Verifies bundled plugin metadata generation and import boundaries.
import fs from "node:fs";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { assert, beforeEach, describe, expect, it } from "vitest";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { resolveBundledPluginGeneratedPath } from "./bundled-plugin-scan.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-ids.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  pluginTestRepoRoot as repoRoot,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type PackageManifest,
} from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeBundledRuntimeSidecarPathBaseline } from "./runtime-sidecar-paths-baseline.js";

const BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS = 300_000;
// llama-cpp starts for its enabled local_image tool factory, not a startup sidecar.
const EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_EXTRAS = ["llama-cpp", "memory-core", "xai"] as const;

installGeneratedPluginTempRootCleanup();

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

function expectGeneratedPathResolution(tempRoot: string, expectedRelativePath: string) {
  expect(
    resolveBundledPluginGeneratedPath(
      tempRoot,
      {
        source: "./plugin/index.ts",
        built: "plugin/index.js",
      },
      undefined,
    ),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

let repoBundledPluginManifestsCache:
  | ReturnType<typeof listRepoBundledPluginManifestsUncached>
  | undefined;

function expectArtifactPresence(
  artifacts: readonly string[] | undefined,
  params: { contains?: readonly string[]; excludes?: readonly string[] },
) {
  if (params.contains) {
    for (const artifact of params.contains) {
      expect(artifacts).toContain(artifact);
    }
  }
  if (params.excludes) {
    for (const artifact of params.excludes) {
      expect(artifacts).not.toContain(artifact);
    }
  }
}

function collectRepoBundledChannelConfigsForTest(dirName: string) {
  const pluginDir = path.join(repoRoot, "extensions", dirName);
  const manifest = loadPluginManifest(pluginDir, false);
  if (!manifest.ok) {
    throw toLintErrorObject(manifest.error, "Non-Error thrown");
  }
  const packagePath = path.join(pluginDir, "package.json");
  const packageManifest: PackageManifest | undefined = fs.existsSync(packagePath)
    ? (JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest)
    : undefined;
  return collectBundledChannelConfigsCore({
    pluginDir,
    manifest: manifest.manifest,
    packageManifest: getPackageManifestMetadata(packageManifest),
  });
}

function listRepoBundledPluginManifestsUncached() {
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return listRepoBundledPluginManifestDirs().flatMap((dirName) => {
    const result = loadPluginManifest(path.join(bundledPluginsDir, dirName), false);
    return result.ok ? [{ dirName, manifest: result.manifest }] : [];
  });
}

function listRepoBundledPluginManifestDirs(): string[] {
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function listRepoBundledPluginManifests() {
  repoBundledPluginManifestsCache ??= listRepoBundledPluginManifestsUncached();
  return repoBundledPluginManifestsCache;
}

function createRepoBundledManifestRegistry(): PluginManifestRegistry {
  return {
    plugins: listRepoBundledPluginManifests().map(({ manifest, dirName }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      enabledByDefault: manifest.enabledByDefault === true ? true : undefined,
      enabledByDefaultOnPlatforms: manifest.enabledByDefaultOnPlatforms,
      kind: manifest.kind,
      channels: manifest.channels ?? [],
      providers: manifest.providers ?? [],
      cliBackends: manifest.cliBackends ?? [],
      syntheticAuthRefs: manifest.syntheticAuthRefs ?? [],
      nonSecretAuthMarkers: manifest.nonSecretAuthMarkers ?? [],
      skills: manifest.skills ?? [],
      origin: "bundled",
      rootDir: path.join(repoRoot, "extensions", dirName),
      source: path.join(repoRoot, "extensions", dirName, "index.ts"),
      manifestPath: path.join(repoRoot, "extensions", dirName, "openclaw.plugin.json"),
      activation: manifest.activation,
      setup: manifest.setup,
      modelCatalog: manifest.modelCatalog,
      hooks: [],
      contracts: manifest.contracts,
    })),
    diagnostics: [],
  };
}

function hasPluginKind(record: PluginManifestRecord, kind: string): boolean {
  return Array.isArray(record.kind) ? record.kind.includes(kind as never) : record.kind === kind;
}

function createInstalledPluginRecordForManifest(
  record: PluginManifestRecord,
): InstalledPluginIndexRecord {
  return {
    pluginId: record.id,
    manifestPath: record.manifestPath,
    manifestHash: `test-${record.id}`,
    source: record.source,
    rootDir: record.rootDir,
    origin: record.origin,
    enabled: record.enabledByDefault === true,
    ...(record.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(record.enabledByDefaultOnPlatforms?.length
      ? { enabledByDefaultOnPlatforms: record.enabledByDefaultOnPlatforms }
      : {}),
    startup: {
      sidecar: record.activation?.onStartup === true,
      memory: hasPluginKind(record, "memory"),
      agentHarnesses: [
        ...new Set([...(record.activation?.onAgentHarnesses ?? []), ...record.cliBackends]),
      ].toSorted((left, right) => left.localeCompare(right)),
    },
    compat: [],
  };
}

function createInstalledPluginIndexForManifests(
  manifestRegistry: PluginManifestRegistry,
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: manifestRegistry.plugins.map(createInstalledPluginRecordForManifest),
    diagnostics: [],
  };
}

describe("bundled plugin metadata", () => {
  it(
    "matches the checked-in runtime sidecar path baseline",
    { timeout: BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS },
    async () => {
      await expect(
        writeBundledRuntimeSidecarPathBaseline({ repoRoot, check: true }),
      ).resolves.toMatchObject({ changed: false });
    },
  );

  it("captures setup-entry metadata for bundled channel plugins", () => {
    const discord = listBundledPluginMetadata({
      rootDir: repoRoot,
      includeSyntheticChannelConfigs: false,
    }).find((entry) => entry.dirName === "discord");
    expect(discord?.source).toEqual({ source: "./index.ts", built: "index.js" });
    expect(discord?.setupSource).toEqual({ source: "./setup-entry.ts", built: "setup-entry.js" });
    expectArtifactPresence(discord?.publicSurfaceArtifacts, {
      contains: ["api.js", "runtime-api.js", "session-key-api.js"],
      excludes: ["test-api.js"],
    });
    expectArtifactPresence(discord?.runtimeSidecarArtifacts, {
      contains: ["runtime-api.js"],
    });
    expect(discord?.manifest.id).toBe("discord");
    const discordChannelConfig = collectRepoBundledChannelConfigsForTest("discord")?.discord as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(discordChannelConfig?.schema?.type).toBe("object");
  });

  it("loads tlon channel config metadata from the lightweight schema surface", () => {
    const tlonChannelConfig = collectRepoBundledChannelConfigsForTest("tlon")?.tlon as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(tlonChannelConfig?.schema?.type).toBe("object");
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

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("extensions", "plugin", "index.ts"));

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("dist", "extensions", "plugin", "index.js"));
  });

  it("keeps generated entry path resolution inside bundled plugin roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-path-contained-");
    const sourcePluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");
    const absoluteEscape = path.join(tempRoot, "absolute.js");
    const absolutePluginEntry = path.join(sourcePluginRoot, "index.ts");

    fs.mkdirSync(sourcePluginRoot, { recursive: true });
    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(absolutePluginEntry, "export {};\n", "utf8");
    fs.writeFileSync(path.join(tempRoot, "extensions", "escape.ts"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "dist", "extensions", "escape.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(absoluteEscape, "export {};\n", "utf8");

    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absolutePluginEntry,
          built: absolutePluginEntry,
        },
        "alpha",
      ),
    ).toBe(absolutePluginEntry);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "../escape.ts",
          built: "../escape.js",
        },
        "alpha",
      ),
    ).toBeNull();
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absoluteEscape,
          built: absoluteEscape,
        },
        "alpha",
      ),
    ).toBeNull();
  });

  it("scans direct plugin-tree overrides and resolves generated paths from that scan dir", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-tree-");
    const pluginsDir = path.join(tempRoot, "bundled-plugins");
    const pluginRoot = path.join(pluginsDir, "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      channels: ["alpha"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    const builtRoot = path.join(tempRoot, "dist", "extensions", "alpha");
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(path.join(builtRoot, "index.js"), "export const built = true;\n", "utf8");
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

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "Before",
      configSchema: { type: "object" },
    });

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
