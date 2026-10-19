import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  makeBundledEsmFixtureRoot,
  writeAlphaSdkAliasDistFixture,
} from "./bundled.shape-guard.test-helpers.js";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

function loadBundled(scope: string) {
  return importFreshModule<typeof import("./bundled.js")>(
    import.meta.url,
    `./bundled.js?scope=${scope}`,
  );
}

function writeEntry(pluginDir: string, file: string, lines: string[]) {
  fs.writeFileSync(path.join(pluginDir, file), lines.join("\n"), "utf8");
}

const testGlobal = globalThis as typeof globalThis & {
  __bundledOverrideRuntime?: unknown;
  __bundledRootRuntime?: unknown;
  __bundledPluginFailureLoads?: number;
  __bundledSetupFailureLoads?: number;
  __bundledSecretsFailureLoads?: number;
  __bundledSetupSecretsFailureLoads?: number;
  __escapedBundledSourceLoaded?: boolean;
  __bundledPluginUndefinedLoads?: number;
};

type BundledEntrySource = { built?: string; source?: string };
const alphaEntryHeader = [
  "export default {",
  "  kind: 'bundled-channel-entry',",
  "  id: 'alpha',",
  "  name: 'Alpha',",
  "  description: 'Alpha',",
  "  register() {},",
];

function writeRuntimeOverride(pluginDir: string) {
  writeEntry(pluginDir, "index.js", [
    'globalThis["__bundledOverrideRuntime"] = undefined;',
    "const plugin = { id: 'alpha', meta: {}, capabilities: {}, config: {} };",
    ...alphaEntryHeader,
    "  loadChannelPlugin() { return plugin; },",
    '  setChannelRuntime(runtime) { globalThis["__bundledOverrideRuntime"] = runtime.marker; },',
    "};",
    "",
  ]);
}

function entrySource(source: string) {
  return { source, built: source };
}

function alphaChannelMetadata({
  includeSetup = false,
  rootDir = path.join(
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? path.resolve("extensions"),
    "alpha",
  ),
}: { includeSetup?: boolean; rootDir?: string } = {}) {
  return {
    dirName: "alpha",
    rootDir,
    manifest: {
      id: "alpha",
      channels: ["alpha"],
    },
    source: entrySource("./index.js"),
    ...(includeSetup
      ? {
          setupSource: entrySource("./setup-entry.js"),
        }
      : {}),
  };
}

function resolveAlphaDistExtensionEntry(
  rootDir: string,
  entry: BundledEntrySource,
  pluginDirName?: string,
) {
  return path.join(
    rootDir,
    "dist",
    "extensions",
    pluginDirName ?? "alpha",
    (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, ""),
  );
}

function mockAlphaDistExtensionRuntime() {
  // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [alphaChannelMetadata({ includeSetup: true })],
    resolveBundledChannelGeneratedPath: resolveAlphaDistExtensionEntry,
  }));
}

function listSourceBundledPluginRoots(): string[] {
  const extensionsDir = path.resolve("extensions");
  const externalRoots =
    listMarkerRoots(
      "git",
      ["ls-files", "--", "extensions/*/package.json", "extensions/*/openclaw.plugin.json"],
      extensionsDir,
    ) ??
    listMarkerRoots(
      "find",
      [
        extensionsDir,
        "-mindepth",
        "2",
        "-maxdepth",
        "2",
        "(",
        "-name",
        "package.json",
        "-o",
        "-name",
        "openclaw.plugin.json",
        ")",
      ],
      extensionsDir,
    );
  if (externalRoots) {
    return externalRoots;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name))
    .filter(
      (entryPath) =>
        fs.existsSync(path.join(entryPath, "package.json")) ||
        fs.existsSync(path.join(entryPath, "openclaw.plugin.json")),
    );
}

function listMarkerRoots(command: string, args: string[], extensionsDir: string): string[] | null {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return packageMarkerPathsToRoots(result.stdout.split("\n"), extensionsDir);
}

function packageMarkerPathsToRoots(markerPaths: string[], extensionsDir: string): string[] {
  return [
    ...new Set(
      markerPaths
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => path.resolve(line))
        .map((line) => path.dirname(line))
        .filter((line) => path.dirname(line) === extensionsDir),
    ),
  ].toSorted();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of [
    "__bundledOverrideRuntime",
    "__bundledRootRuntime",
    "__escapedBundledSourceLoaded",
    "__bundledPluginFailureLoads",
    "__bundledSetupFailureLoads",
    "__bundledSecretsFailureLoads",
    "__bundledSetupSecretsFailureLoads",
    "__bundledPluginUndefinedLoads",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
  clearPluginMetadataLifecycleCaches();
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("./bundled-root.js");
});

describe("bundled channel entry shape guards", () => {
  const bundledPluginRoots = listSourceBundledPluginRoots();
  let realBundledSourceTreeProbe: {
    hasAccountInspector: boolean;
    pluginIds: readonly string[];
  };

  beforeAll(async () => {
    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: (params: {
          includeChannelConfigs: boolean;
          includeSyntheticChannelConfigs: boolean;
        }) =>
          actual
            .listBundledChannelPluginMetadata(params)
            .filter((metadata) => metadata.manifest.id === "slack"),
      };
    });
    const bundled = await loadBundled("real-bundled-source-tree-preload");
    realBundledSourceTreeProbe = {
      hasAccountInspector: typeof bundled.getBundledChannelAccountInspector("slack") === "function",
      pluginIds: bundled.listBundledChannelPlugins().map((plugin) => plugin.id),
    };
  });

  it("treats missing bundled discovery results as empty", async () => {
    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: () => [],
      };
    });

    const bundled = await loadBundled("missing-bundled-discovery");

    expect(bundled.listBundledChannelPlugins()).toStrictEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toStrictEqual([]);
  });

  it("loads real bundled channel entry contracts from the source tree", async () => {
    expect(realBundledSourceTreeProbe.pluginIds).toEqual(["slack"]);
    expect(realBundledSourceTreeProbe.hasAccountInspector).toBe(true);
  });

  it("fills sparse bundled channel plugin metadata from package metadata", async () => {
    const tempRoot = makeBundledEsmFixtureRoot("openclaw-bundled-metadata-");
    const pluginDir = path.join(tempRoot, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeEntry(pluginDir, "index.js", [
      "const plugin = {",
      "  id: 'alpha',",
      "  meta: { id: 'alpha' },",
      "  capabilities: { chatTypes: ['direct'] },",
      "  config: {},",
      "};",
      ...alphaEntryHeader,
      "  loadChannelPlugin() { return plugin; },",
      "};",
      "",
    ]);

    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: () => [
        {
          ...alphaChannelMetadata(),
          packageManifest: {
            channel: {
              id: "alpha",
              label: "Alpha",
              selectionLabel: "Use Alpha",
              docsPath: "/channels/alpha",
              blurb: "Alpha channel metadata.",
            },
          },
        },
      ],
      resolveBundledChannelGeneratedPath: (
        _rootDir: string,
        entry: { built?: string; source?: string },
      ) =>
        path.join(pluginDir, (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, "")),
    }));

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(tempRoot, "dist", "extensions"));

    const bundled = await loadBundled("bundled-package-metadata");

    const plugin = bundled.getBundledChannelPlugin("alpha");
    expect(plugin?.meta).toMatchObject({
      id: "alpha",
      label: "Alpha",
      selectionLabel: "Use Alpha",
      docsPath: "/channels/alpha",
      blurb: "Alpha channel metadata.",
    });
  });

  it.each(["package", "direct"] as const)(
    "loads entries through a %s root override",
    async (layout) => {
      const root = makeBundledEsmFixtureRoot("openclaw-bundled-override-");
      const pluginsRoot =
        layout === "direct"
          ? path.join(root, "bundled-plugins")
          : path.join(root, "dist", "extensions");
      const pluginDir = path.join(pluginsRoot, "alpha");
      fs.mkdirSync(pluginDir, { recursive: true });
      writeRuntimeOverride(pluginDir);
      const observed: {
        metadata?: { rootDir?: string; scanDir?: string };
        generated?: { rootDir: string; scanDir?: string };
      } = {};
      // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
      vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
        listBundledChannelPluginMetadata: (params?: { rootDir?: string; scanDir?: string }) => {
          observed.metadata = params;
          return [alphaChannelMetadata()];
        },
        resolveBundledChannelGeneratedPath: (
          rootDir: string,
          entry: BundledEntrySource,
          pluginDirName?: string,
          scanDir?: string,
        ) => {
          observed.generated = { rootDir, scanDir };
          return path.join(
            scanDir ?? path.join(rootDir, "dist", "extensions"),
            pluginDirName ?? "alpha",
            (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, ""),
          );
        },
      }));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginsRoot);
      const bundled = await loadBundled(`bundled-${layout}-override-root`);
      bundled.setBundledChannelRuntime("alpha", { marker: "ok" } as never);
      const rootDir = layout === "direct" ? pluginsRoot : root;
      expect(observed).toMatchObject({
        metadata: { rootDir, scanDir: pluginsRoot },
        generated: { rootDir, scanDir: pluginsRoot },
      });
      expect(testGlobal["__bundledOverrideRuntime"]).toBe("ok");
      expect(bundled.getBundledChannelPlugin("alpha")?.id).toBe("alpha");
    },
  );

  it.each(["package-local", "direct"] as const)(
    "loads %s dist entries with SDK aliases",
    async (layout) => {
      const root = makeBundledEsmFixtureRoot("openclaw-bundled-dist-");
      const pluginsRoot = path.join(root, "bundled-plugins");
      const pluginDir =
        layout === "direct"
          ? path.join(pluginsRoot, "alpha", "dist")
          : path.join(root, "extensions", "alpha", "dist");
      const label = layout === "direct" ? "Direct dist Alpha" : "Package dist Alpha";
      writeAlphaSdkAliasDistFixture(pluginDir, label);
      if (layout === "package-local") {
        // mock-isolation: The fixture owns the package root instead of probing the host installation.
        vi.doMock("./bundled-root.js", () => ({
          resolveBundledChannelRootScope: () => ({
            packageRoot: root,
            cacheKey: `${root}:package-local-dist`,
          }),
        }));
      } else {
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginsRoot);
      }
      // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
      vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
        listBundledChannelPluginMetadata: () => [
          layout === "direct"
            ? alphaChannelMetadata()
            : {
                ...alphaChannelMetadata(),
                source: entrySource(path.join(root, "extensions", "alpha", "index.ts")),
                rootDir: path.join(root, "extensions", "alpha"),
              },
        ],
        resolveBundledChannelGeneratedPath: () => path.join(pluginDir, "index.js"),
      }));
      const bundled = await loadBundled(`bundled-${layout}-dist-sdk-alias`);
      expect(bundled.getBundledChannelPlugin("alpha")?.meta.label).toBe(label);
    },
  );

  it("partitions bundled channel lazy caches by active bundled root without re-importing", async () => {
    const rootA = makeBundledEsmFixtureRoot("openclaw-bundled-root-a-");
    const rootB = makeBundledEsmFixtureRoot("openclaw-bundled-root-b-");

    const writeBundledRoot = (rootDir: string, label: string) => {
      const pluginDir = path.join(rootDir, "dist", "extensions", "alpha");
      fs.mkdirSync(pluginDir, { recursive: true });
      writeEntry(pluginDir, "index.js", [
        `globalThis["__bundledRootRuntime"] = globalThis["__bundledRootRuntime"] ?? [];`,
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'alpha',",
        `  name: ${JSON.stringify(`Alpha ${label}`)},`,
        `  description: ${JSON.stringify(`Alpha ${label}`)},`,
        "  register() {},",
        "  loadChannelPlugin() {",
        "    return {",
        "      id: 'alpha',",
        `      meta: { id: 'alpha', label: ${JSON.stringify(`Alpha ${label}`)} },`,
        "      capabilities: {},",
        "      config: {},",
        `      secrets: { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.token`)}, targetType: 'channel' }] },`,
        "    };",
        "  },",
        "  loadChannelSecrets() {",
        `    return { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.entry-token`)}, targetType: 'channel' }] };`,
        "  },",
        "  setChannelRuntime(runtime) {",
        `    globalThis["__bundledRootRuntime"].push(${JSON.stringify(`entry:${label}`)} + ':' + String(runtime.marker));`,
        "  },",
        "};",
        "",
      ]);
      writeEntry(pluginDir, "setup-entry.js", [
        "export default {",
        "  kind: 'bundled-channel-setup-entry',",
        "  loadSetupPlugin() {",
        "    return {",
        "      id: 'alpha',",
        `      meta: { id: 'alpha', label: ${JSON.stringify(`Setup ${label}`)} },`,
        "      capabilities: {},",
        "      config: {},",
        `      secrets: { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.setup-plugin-token`)}, targetType: 'channel' }] },`,
        "    };",
        "  },",
        "  loadSetupSecrets() {",
        `    return { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.setup-entry-token`)}, targetType: 'channel' }] };`,
        "  },",
        "};",
        "",
      ]);
    };

    writeBundledRoot(rootA, "A");
    writeBundledRoot(rootB, "B");

    mockAlphaDistExtensionRuntime();

    const bundled = await loadBundled("bundled-root-partition");

    for (const [root, label, marker] of [
      [rootA, "A", "first"],
      [rootB, "B", "second"],
    ] as const) {
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "dist", "extensions"));
      expect(bundled.getBundledChannelPlugin("alpha")?.meta.label).toBe(`Alpha ${label}`);
      expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe(`Setup ${label}`);
      expect(bundled.getBundledChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id).toBe(
        `channels.alpha.${label}.entry-token`,
      );
      expect(
        bundled.getBundledChannelSetupSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
      ).toBe(`channels.alpha.${label}.setup-entry-token`);
      bundled.setBundledChannelRuntime("alpha", { marker } as never);
    }

    expect(testGlobal["__bundledRootRuntime"]).toEqual(["entry:A:first", "entry:B:second"]);
  });

  it("uses dist-runtime as the boundary root for packaged setup entries", async () => {
    const root = makeBundledEsmFixtureRoot("openclaw-bundled-runtime-root-");
    const pluginDir = path.join(root, "dist-runtime", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeEntry(pluginDir, "setup-entry.js", [
      "export default {",
      "  kind: 'bundled-channel-setup-entry',",
      "  loadSetupPlugin() {",
      "    return {",
      "      id: 'alpha',",
      "      meta: { id: 'alpha', label: 'Setup dist-runtime' },",
      "      capabilities: {},",
      "      config: {},",
      "    };",
      "  },",
      "};",
      "",
    ]);

    // mock-isolation: The fixture owns the package root instead of probing the host installation.
    vi.doMock("./bundled-root.js", () => ({
      resolveBundledChannelRootScope: () => ({
        packageRoot: root,
        cacheKey: `${root}:dist-runtime`,
      }),
    }));
    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: () => [
        alphaChannelMetadata({ includeSetup: true, rootDir: pluginDir }),
      ],
      resolveBundledChannelGeneratedPath: (
        rootDir: string,
        entry: BundledEntrySource | undefined,
        pluginDirName?: string,
      ) =>
        path.join(
          rootDir,
          "dist-runtime",
          "extensions",
          pluginDirName ?? "alpha",
          (entry?.built ?? entry?.source ?? "./index.js").replace(/^\.\//u, ""),
        ),
    }));

    const bundled = await loadBundled("bundled-dist-runtime-boundary");

    expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("Setup dist-runtime");
  });

  it("swallows and caches bundled plugin and setup load failures", async () => {
    const root = makeBundledEsmFixtureRoot("openclaw-bundled-load-failure-");
    const pluginDir = path.join(root, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module", version: "2026.4.21" }),
      "utf8",
    );
    writeEntry(pluginDir, "index.js", [
      ...alphaEntryHeader,
      "  loadChannelSecrets() {",
      '    globalThis["__bundledSecretsFailureLoads"] = (globalThis["__bundledSecretsFailureLoads"] ?? 0) + 1;',
      "    throw new Error('missing channel secrets dep');",
      "  },",
      "  loadChannelPlugin() {",
      '    globalThis["__bundledPluginFailureLoads"] = (globalThis["__bundledPluginFailureLoads"] ?? 0) + 1;',
      "    throw new Error('missing channel plugin dep');",
      "  },",
      "};",
      "",
    ]);
    writeEntry(pluginDir, "setup-entry.js", [
      "export default {",
      "  kind: 'bundled-channel-setup-entry',",
      "  loadSetupSecrets() {",
      '    globalThis["__bundledSetupSecretsFailureLoads"] = (globalThis["__bundledSetupSecretsFailureLoads"] ?? 0) + 1;',
      "    throw new Error('missing setup secrets dep');",
      "  },",
      "  loadSetupPlugin() {",
      '    globalThis["__bundledSetupFailureLoads"] = (globalThis["__bundledSetupFailureLoads"] ?? 0) + 1;',
      "    throw new Error('missing setup plugin dep');",
      "  },",
      "};",
      "",
    ]);

    mockAlphaDistExtensionRuntime();

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "dist", "extensions"));

    const bundled = await loadBundled("bundled-load-failure");

    expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSetupPlugin("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSetupPlugin("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSecrets("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSecrets("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSetupSecrets("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelSetupSecrets("alpha")).toBeUndefined();
    expect(testGlobal["__bundledPluginFailureLoads"]).toBe(1);
    expect(testGlobal["__bundledSetupFailureLoads"]).toBe(1);
    expect(testGlobal["__bundledSecretsFailureLoads"]).toBe(1);
    expect(testGlobal["__bundledSetupSecretsFailureLoads"]).toBe(1);
  });

  it("falls back to a contained source-only registry root when generated lookup misses", async () => {
    const root = makeBundledEsmFixtureRoot("openclaw-bundled-source-fallback-");
    const outsideRoot = makeBundledEsmFixtureRoot("openclaw-bundled-source-fallback-outside-");
    const pluginsDir = path.join(root, "dist", "extensions");
    const pluginDir = path.join(root, "extensions", "alpha");
    const escapedPluginDir = path.join(outsideRoot, "escape");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(escapedPluginDir, { recursive: true });
    writeEntry(pluginDir, "index.js", [
      ...alphaEntryHeader,
      "  loadChannelPlugin() {",
      "    return { id: 'alpha', meta: { label: 'Source Alpha' }, capabilities: {}, config: {} };",
      "  },",
      "};",
      "",
    ]);
    writeEntry(pluginDir, "setup-entry.js", [
      "export default {",
      "  kind: 'bundled-channel-setup-entry',",
      "  loadSetupPlugin() {",
      "    return { id: 'alpha', meta: { label: 'Setup Alpha' }, capabilities: {}, config: {} };",
      "  },",
      "};",
      "",
    ]);
    fs.writeFileSync(
      path.join(escapedPluginDir, "index.js"),
      [
        "globalThis.__escapedBundledSourceLoaded = true;",
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'escape',",
        "  name: 'Escape',",
        "  description: 'Escape',",
        "  register() {},",
        "  loadChannelPlugin() { return { id: 'escape', meta: {}, capabilities: {}, config: {} }; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: () => [
        {
          ...alphaChannelMetadata({ includeSetup: true }),
          rootDir: pluginDir,
        },
        {
          dirName: "escape",
          rootDir: escapedPluginDir,
          source: entrySource(path.join(escapedPluginDir, "index.js")),
          manifest: {
            id: "escape",
            channels: ["escape"],
          },
        },
      ],
      resolveBundledChannelGeneratedPath: () => null,
    }));

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginsDir);
    const bundled = await loadBundled("bundled-source-registry-fallback");

    expect(bundled.getBundledChannelPlugin("alpha")?.meta.label).toBe("Source Alpha");
    expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("Setup Alpha");
    expect(bundled.getBundledChannelPlugin("escape")).toBeUndefined();
    expect(testGlobal["__escapedBundledSourceLoaded"]).toBeUndefined();
  });

  it("accepts canonical built entries through the active package symlink", async () => {
    const root = makeBundledEsmFixtureRoot("openclaw-bundled-alias-boundary-");
    const releaseRoot = path.join(root, "releases", "release-sha");
    const currentRoot = path.join(root, "current");
    const pluginDir = path.join(releaseRoot, "dist", "extensions", "alpha");
    const setupEntryPath = path.join(pluginDir, "setup-entry.cjs");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.symlinkSync(releaseRoot, currentRoot, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(
      setupEntryPath,
      [
        "module.exports = {",
        "  kind: 'bundled-channel-setup-entry',",
        "  loadSetupPlugin() {",
        "    return { id: 'alpha', meta: { label: 'Aliased Alpha' }, capabilities: {}, config: {} };",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    // mock-isolation: Synthetic runtime metadata isolates bundled-root selection from installed plugins.
    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: () => [
        {
          ...alphaChannelMetadata({ includeSetup: true }),
          rootDir: pluginDir,
          setupSource: entrySource(setupEntryPath),
        },
      ],
      resolveBundledChannelGeneratedPath: () => null,
    }));

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(currentRoot, "dist", "extensions"));
    const bundled = await loadBundled("bundled-alias-boundary");

    expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("Aliased Alpha");
  });

  it("caches undefined bundled plugin loads as unavailable", async () => {
    const root = makeBundledEsmFixtureRoot("openclaw-bundled-null-load-");
    const pluginDir = path.join(root, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeEntry(pluginDir, "index.js", [
      ...alphaEntryHeader,
      "  loadChannelPlugin() {",
      '    globalThis["__bundledPluginUndefinedLoads"] = (globalThis["__bundledPluginUndefinedLoads"] ?? 0) + 1;',
      "    return undefined;",
      "  },",
      "};",
      "",
    ]);

    mockAlphaDistExtensionRuntime();

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "dist", "extensions"));

    const bundled = await loadBundled("bundled-undefined-load");

    expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
    expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
    expect(testGlobal["__bundledPluginUndefinedLoads"]).toBe(1);
  });

  it("keeps plugin-sdk channel-core free of chat metadata bootstrap imports", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/channel-core.ts"), "utf8");

    expect(source).not.toContain("../channels/chat-meta.js");
    expect(source).not.toContain("getChatChannelMeta");
  });

  it("keeps runtime helper surfaces off bootstrap-registry", () => {
    const offenders = [
      "src/config/markdown-tables.ts",
      "src/config/sessions/group.ts",
      "src/channels/plugins/setup-helpers.ts",
      "src/plugin-sdk/extension-shared.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("bootstrap-registry.js"),
    );

    expect(offenders).toStrictEqual([]);
  });

  it("keeps private src runtime barrels from forwarding to parent runtime barrels that export local plugins", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      const privateRuntimePath = path.join(extensionDir, "src", "runtime-api.ts");
      const publicRuntimePath = path.join(extensionDir, "runtime-api.ts");
      if (!fs.existsSync(privateRuntimePath) || !fs.existsSync(publicRuntimePath)) {
        continue;
      }
      const privateRuntimeSource = fs.readFileSync(privateRuntimePath, "utf8");
      const publicRuntimeSource = fs.readFileSync(publicRuntimePath, "utf8");
      const forwardsParentRuntime =
        privateRuntimeSource.includes('export * from "../runtime-api.js"') ||
        privateRuntimeSource.includes("export * from '../runtime-api.js'");
      const exportsLocalPlugin =
        publicRuntimeSource.includes('from "./src/channel.js"') &&
        /export\s+\{\s*[\w$]+Plugin\s*\}\s+from\s+["']\.\/src\/channel\.js["']/u.test(
          publicRuntimeSource,
        );
      if (forwardsParentRuntime && exportsLocalPlugin) {
        offenders.push(path.relative(process.cwd(), publicRuntimePath));
      }
    }

    expect(offenders).toStrictEqual([]);
  });
});
