import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  getLoadedRuntimePluginRegistry,
  listLoadedRuntimePluginIds,
  listRuntimePluginIdsFromRegistry,
  createRuntimePluginManifestLookup,
} from "./active-runtime-registry.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

function createRegistryWithPlugin(
  pluginId: string,
  overrides: Partial<PluginRegistry["plugins"][number]> = {},
): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
    ...overrides,
  } as never);
  return registry;
}

function activate(registry: PluginRegistry, key = "fixture", workspaceDir = "/tmp/ws") {
  setActivePluginRegistry(registry, key, "default", workspaceDir);
}

function lookup(requiredPluginIds: string[]) {
  return getLoadedRuntimePluginRegistry({ workspaceDir: "/tmp/ws", requiredPluginIds });
}

function createLoadOptions(
  plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
  options: Partial<PluginLoadOptions> = {},
): PluginLoadOptions {
  return {
    config: { plugins: { allow: [plugin.id], entries: { [plugin.id]: { enabled: true } } } },
    env: {},
    installRecords: {},
    onlyPluginIds: [plugin.id],
    activate: false,
    manifestRegistry: createPluginMetadataSnapshotFixture({
      plugins: [{ configSchema: EMPTY_PLUGIN_SCHEMA, ...plugin }],
    }).manifestRegistry,
    ...options,
  };
}

describe("getLoadedRuntimePluginRegistry", () => {
  it("treats an explicit empty plugin scope as empty", () => {
    activate(createRegistryWithPlugin("stale"));
    expect(lookup([])).toBeUndefined();

    const emptyRegistry = createEmptyPluginRegistry();
    activate(emptyRegistry);
    expect(lookup([])).toBe(emptyRegistry);
  });

  it("does not treat disabled plugin records as an empty plugin scope", () => {
    activate(createRegistryWithPlugin("disabled", { status: "disabled" }));
    expect(lookup([])).toBeUndefined();
  });

  it.each(["diagnostics", "channelSetups"] as const)(
    "does not treat %s as loaded plugin records",
    (registration) => {
      const registry = createRegistryWithPlugin("unloaded", {
        status: registration === "diagnostics" ? "error" : "disabled",
      });
      if (registration === "diagnostics") {
        registry.diagnostics.push({
          level: "error",
          pluginId: "unloaded",
          message: "failed to load",
        } as never);
      } else {
        registry.channelSetups.push({ pluginId: "unloaded" } as never);
      }
      activate(registry);
      expect(lookup(["unloaded"])).toBeUndefined();
    },
  );

  it.each(["openclaw", "bundle"] as const)("checks deferred %s metadata availability", (format) => {
    const registry = createRegistryWithPlugin("metadata", { format, imported: false });
    activate(registry);
    expect(lookup(["metadata"])).toBe(format === "bundle" ? registry : undefined);
    const expected = format === "bundle" ? ["metadata"] : [];
    expect(listLoadedRuntimePluginIds()).toEqual(expected);
    expect(listRuntimePluginIdsFromRegistry(registry)).toEqual(expected);
  });

  it("reuses scoped loaded owners when load options differ from the active registry", () => {
    const registry = createRegistryWithPlugin("demo");
    activate(registry, "gateway-root-key");

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: { workspaceDir: "/tmp/ws", onlyPluginIds: ["demo"] },
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["demo"],
      }),
    ).toBe(registry);
  });

  it("keeps exact-key semantics for unscoped load-option requests", () => {
    activate(createRegistryWithPlugin("demo"));

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: { workspaceDir: "/tmp/ws" },
        workspaceDir: "/tmp/ws",
      }),
    ).toBeUndefined();
  });

  it("does not reuse workspace-agnostic registries for workspace-specific requests", () => {
    setActivePluginRegistry(createRegistryWithPlugin("demo"), "demo");

    expect(lookup(["demo"])).toBeUndefined();
  });

  it("honors the requested workspace when scoped load options match the active key", () => {
    const registry = createRegistryWithPlugin("demo");
    const loadOptions = {
      config: {},
      installRecords: {},
      workspaceDir: "/tmp/owner-workspace",
      onlyPluginIds: ["demo"],
    };
    activate(
      registry,
      resolvePluginLoadCacheContext(loadOptions).cacheKey,
      loadOptions.workspaceDir,
    );

    expect(
      getLoadedRuntimePluginRegistry({ loadOptions, workspaceDir: "/tmp/request-workspace" }),
    ).toBeUndefined();
  });

  it("rejects a request registry when a workspace selects another physical owner", () => {
    const registry = createRegistryWithPlugin("demo", {
      origin: "bundled",
      rootDir: "/plugins/demo",
      source: "/plugins/demo/index.js",
    });

    expect(
      createRuntimePluginManifestLookup(registry, [
        {
          id: "demo",
          origin: "workspace",
          rootDir: "/tmp/session-workspace/.openclaw/extensions/demo",
          source: "/tmp/session-workspace/.openclaw/extensions/demo/index.js",
        } as never,
      ])("demo"),
    ).toBeUndefined();
  });
});

it.each(["setup", "full"] as const)(
  "matches the executable setup source selected by a %s load",
  (channelPluginLoadIntent) => {
    const runtime = writePlugin({
      id: "setup-fixture",
      filename: "index.cjs",
      body: 'module.exports = { id: "setup-fixture", register() {} };',
    });
    for (const label of ["old", "new"]) {
      writeFileSync(
        path.join(runtime.dir, `${label}.cjs`),
        `module.exports = { plugin: {
        id: "setup-channel", meta: { id: "setup-channel", label: ${JSON.stringify(label)},
          selectionLabel: "Fixture", docsPath: "/synthetic", blurb: "Synthetic fixture" },
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      }};`,
      );
    }
    const options = (label: string) =>
      createLoadOptions(
        {
          id: runtime.id,
          origin: "global",
          rootDir: runtime.dir,
          source: runtime.file,
          channels: ["setup-channel"],
          setupSource: path.join(runtime.dir, `${label}.cjs`),
          providerDiscoverySource: path.join(runtime.dir, `${label}.cjs`),
          capabilityCatalogSource: path.join(runtime.dir, `${label}.cjs`),
        },
        { channelPluginLoadIntent },
      );
    const old = loadOpenClawPlugins(options("old"));
    const next = loadOpenClawPlugins(options("new"));
    expect(old.plugins[0]?.status).toBe("loaded");
    setActivePluginRegistry(old, "old");
    const reused = getLoadedRuntimePluginRegistry({ loadOptions: options("new") });
    if (channelPluginLoadIntent === "setup") {
      expect([old.channels[0]?.plugin.meta.label, next.channels[0]?.plugin.meta.label]).toEqual([
        "old",
        "new",
      ]);
      expect(reused === undefined).toBe(true);
    } else {
      expect(old.channels).toEqual([]);
      expect(reused === old).toBe(true);
    }
  },
);

it.each([
  { sourceFormat: "cts", builtFormat: "cjs", preferBuiltPluginArtifacts: false },
  { sourceFormat: "cts", builtFormat: "cjs", preferBuiltPluginArtifacts: true },
  { sourceFormat: "mts", builtFormat: "mjs", preferBuiltPluginArtifacts: false },
  { sourceFormat: "mts", builtFormat: "mjs", preferBuiltPluginArtifacts: true },
])(
  "reuses selected bundled setup $sourceFormat/$builtFormat artifacts with built=$preferBuiltPluginArtifacts",
  ({ sourceFormat, builtFormat, preferBuiltPluginArtifacts }) => {
    const schema = EMPTY_PLUGIN_SCHEMA;
    const packageRoot = makePluginLoaderTempDir();
    const options = [
      { format: sourceFormat, tree: "extensions" },
      { format: builtFormat, tree: "dist/extensions" },
      { format: builtFormat, tree: "dist-runtime/extensions" },
    ].map(({ format, tree }) => {
      const rootDir = path.join(packageRoot, tree, "bundled-setup");
      mkdirSync(rootDir, { recursive: true });
      const source = path.join(rootDir, `index.${format}`);
      const setupSource = path.join(rootDir, `setup.${format}`);
      const label = tree === "extensions" ? "source" : "built";
      const exported = ["mts", "mjs"].includes(format) ? "export default" : "module.exports =";
      writeFileSync(source, `${exported} { id: "bundled-setup", register() {} };`);
      writeFileSync(
        setupSource,
        `${exported} { plugin: {
      id: "bundled-setup", meta: { id: "bundled-setup", label: ${JSON.stringify(label)}, selectionLabel: "Fixture", docsPath: "/synthetic", blurb: "Synthetic fixture" },
      capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }};`,
      );
      writeFileSync(
        path.join(rootDir, "package.json"),
        JSON.stringify({
          openclaw: { extensions: [`./index.${format}`], setupEntry: `./setup.${format}` },
        }),
      );
      writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "bundled-setup", channels: ["bundled-setup"], configSchema: schema }),
      );
      return createLoadOptions(
        { id: "bundled-setup", rootDir, source, setupSource, channels: ["bundled-setup"] },
        { preferBuiltPluginArtifacts, channelPluginLoadIntent: "setup" },
      );
    });
    const expectedLabel = (index: number) =>
      preferBuiltPluginArtifacts || index !== 0 ? "built" : "source";
    for (const [loadedIndex, loadedOptions] of options.entries()) {
      const loaded = loadOpenClawPlugins(loadedOptions);
      expect(loaded.channels[0]?.plugin.meta.label).toBe(expectedLabel(loadedIndex));
      setActivePluginRegistry(loaded, "canonical-view");
      for (const [requestedIndex, requestedOptions] of options.entries()) {
        expect(getLoadedRuntimePluginRegistry({ loadOptions: requestedOptions }) === loaded).toBe(
          expectedLabel(loadedIndex) === expectedLabel(requestedIndex),
        );
      }
    }
  },
);

it("does not reuse a different explicitly selected bundled entry", () => {
  const runtime = writePlugin({
    id: "entry-fixture",
    filename: "index.cjs",
    registration: `api.registerProvider({ id: "entry-provider", label: "Old", auth: [] });`,
  });
  const selectedSource = path.join(runtime.dir, "selected.cjs");
  writeFileSync(
    selectedSource,
    `module.exports = { id: "entry-fixture", register(api) {
    api.registerProvider({ id: "entry-provider", label: "Selected", auth: [] });
  }};`,
  );
  const options = (source: string) =>
    createLoadOptions({
      id: runtime.id,
      rootDir: runtime.dir,
      source,
      sourcePreferred: true,
      providers: ["entry-provider"],
    });
  const old = loadOpenClawPlugins(options(runtime.file));
  expect(old.providers[0]?.provider.label).toBe("Old");
  setActivePluginRegistry(old, "old-entry");
  expect(getLoadedRuntimePluginRegistry({ loadOptions: options(selectedSource) })).toBeUndefined();
  expect(loadOpenClawPlugins(options(selectedSource)).providers[0]?.provider.label).toBe(
    "Selected",
  );
});

it("compares the executed artifact after the loader's final staging pass", () => {
  const packageRoot = makePluginLoaderTempDir();
  let source = path.join(
    packageRoot,
    "dist-runtime/extensions/a/dist-runtime/extensions/b/dist-runtime/extensions/c/index.cjs",
  );
  const selectedSource = source;
  for (let stage = 0; stage <= 3; stage += 1) {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(
      source,
      `module.exports = { id: "staged-fixture", register(api) {
        api.registerProvider({ id: "staged-provider", label: "stage-${stage}", auth: [] });
      }};`,
    );
    source = source.replace(
      `${path.sep}dist-runtime${path.sep}extensions${path.sep}`,
      `${path.sep}dist${path.sep}extensions${path.sep}`,
    );
  }
  const options = createLoadOptions(
    {
      id: "staged-fixture",
      rootDir: path.dirname(selectedSource),
      source: selectedSource,
      providers: ["staged-provider"],
    },
    { preferBuiltPluginArtifacts: false },
  );
  const loaded = loadOpenClawPlugins(options);
  expect(loaded.providers[0]?.provider.label).toBe("stage-3");
  setActivePluginRegistry(loaded, "executed-stage");
  expect(getLoadedRuntimePluginRegistry({ loadOptions: options }) === loaded).toBe(true);
});
