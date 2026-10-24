import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectChannelSchemaMetadataCore } from "../config/channel-config-metadata.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import { loadPluginManifestRegistryCore, type PluginManifestRecord } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs: string[] = [];
function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o755);
  }
}

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-registry", tempDirs);
}

function makeOpenClawDevSourceRoot() {
  const root = makeTempDir();
  writeTextFile(root, "package.json", JSON.stringify({ name: "openclaw" }));
  writeTextFile(root, "pnpm-workspace.yaml", "packages: [extensions/*]\n");
  mkdirSafe(path.join(root, "src"));
  mkdirSafe(path.join(root, "extensions"));
  return root;
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  writeTextFile(
    dir,
    "openclaw.plugin.json",
    JSON.stringify({ configSchema: { type: "object" }, ...manifest }),
  );
}

function writeTextFile(rootDir: string, relativePath: string, value: string) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf-8");
}

function setupBundleFixture(params: {
  bundleDir: string;
  dirs?: readonly string[];
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.bundleDir, relativeDir));
  }
  for (const [relativePath, value] of Object.entries(params.textFiles ?? {})) {
    writeTextFile(params.bundleDir, relativePath, value);
  }
  if (params.manifestRelativePath && params.manifest) {
    writeTextFile(params.bundleDir, params.manifestRelativePath, JSON.stringify(params.manifest));
  }
}

function createPluginCandidate(
  idHint: string,
  rootDir: string,
  origin: PluginCandidate["origin"],
  options: Partial<
    Pick<
      PluginCandidate,
      | "format"
      | "bundleFormat"
      | "packageName"
      | "packageVersion"
      | "packageManifest"
      | "packageDir"
    >
  > & { sourceName?: string; installOwner?: string } = {},
): PluginCandidate {
  const { sourceName = "index.ts", installOwner, ...metadata } = options;
  return recordPluginCandidateInstallOwner(
    { idHint, rootDir, origin, source: path.join(rootDir, sourceName), ...metadata },
    installOwner,
  );
}

function makePluginDir(id: string, metadata: Record<string, unknown> = {}) {
  const dir = makeTempDir();
  writeManifest(dir, { id, ...metadata });
  return dir;
}

function createMsteamsClawHubInstallRecord(
  installPath: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "clawhub",
    spec: "clawhub:@openclaw/msteams",
    installPath,
    clawhubUrl: "https://clawhub.ai",
    clawhubPackage: "@openclaw/msteams",
    clawhubChannel: "official",
    ...overrides,
  };
}

function officialCandidate(id: string, dir: string, origin: PluginCandidate["origin"] = "global") {
  return createPluginCandidate(id, dir, origin, {
    packageName: `@openclaw/${id}`,
    installOwner: id,
  });
}

function loadOfficialRegistry(
  id: string,
  dir: string,
  record: PluginInstallRecord,
  origins: PluginCandidate["origin"][] = ["global"],
) {
  return loadPluginManifestRegistryCore({
    installRecords: { [id]: record },
    candidates: origins.map((origin) => officialCandidate(id, dir, origin)),
  });
}

function resolveOfficialTrust(source: "npm" | "clawhub", overrides: Partial<PluginInstallRecord>) {
  const id = source === "npm" ? "diffs" : "msteams";
  const dir = makePluginDir(id);
  const record =
    source === "clawhub"
      ? createMsteamsClawHubInstallRecord(dir, overrides)
      : {
          source,
          spec: "@openclaw/diffs",
          installPath: dir,
          resolvedName: "@openclaw/diffs",
          resolvedVersion: "2026.7.16",
          resolvedSpec: "@openclaw/diffs@2026.7.16",
          ...overrides,
        };
  return loadOfficialRegistry(id, dir, record).plugins[0]?.trustedOfficialInstall;
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistryCore({ candidates });
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: undefined,
    VITEST: "true",
    ...overrides,
  };
}

type Registry = ReturnType<typeof loadPluginManifestRegistryCore>;

function countDuplicateWarnings(registry: Registry): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "warn" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

function expectRegistryDiagnosticContains(registry: Registry, fragment: string) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).toContain(fragment);
}

function expectNoRegistryDiagnosticContains(registry: Registry, fragment: string) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(fragment);
}

function expectDiagnosticFields(
  registry: Registry,
  expected: { level?: string; pluginId?: string; source?: string; messageIncludes?: string },
) {
  const { messageIncludes, ...fields } = expected;
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({
      ...fields,
      ...(messageIncludes ? { message: expect.stringContaining(messageIncludes) } : {}),
    }),
  );
}

function linkFile(mode: "symlink" | "hardlink", source: string, target: string) {
  try {
    (mode === "symlink" ? fs.symlinkSync : fs.linkSync)(source, target);
    return true;
  } catch (error) {
    if (
      mode === "symlink" ||
      (error instanceof Error && "code" in error && error.code === "EXDEV")
    ) {
      return false;
    }
    throw error;
  }
}

function loadSingleCandidateRegistry(
  idHint: string,
  rootDir: string,
  origin: PluginCandidate["origin"],
) {
  return loadRegistry([createPluginCandidate(idHint, rootDir, origin)]);
}

function compatibilityCandidate(params: {
  rootDir: string;
  minHostVersion?: string;
  pluginApi?: unknown;
  origin?: PluginCandidate["origin"];
  idHint?: string;
}) {
  return createPluginCandidate(
    params.idHint ?? "synology-chat",
    params.rootDir,
    params.origin ?? "global",
    {
      packageDir: params.rootDir,
      packageManifest: {
        install: {
          npmSpec: `@openclaw/${params.idHint ?? "synology-chat"}`,
          minHostVersion: params.minHostVersion ?? ">=2026.4.25",
        },
        ...(params.pluginApi === undefined
          ? {}
          : {
              compat: {
                pluginApi: params.pluginApi as string,
              },
            }),
      },
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifestRegistry", () => {
  it("keeps manifest and artwork facts stable until a fresh operation reads changes", () => {
    const stateDir = fs.realpathSync(makeTempDir());
    const pluginDir = path.join(stateDir, "extensions", "cached-manifest");
    mkdirSafe(pluginDir);
    writeTextFile(pluginDir, "index.js", "export default function () {}");
    writeTextFile(
      pluginDir,
      "package.json",
      JSON.stringify({
        name: "@openclaw/cached-manifest",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    writeManifest(pluginDir, { id: "cached-manifest", name: "Before" });
    writeTextFile(pluginDir, "assets/activity/before.svg", "before activity");
    const env = hermeticEnv({ OPENCLAW_STATE_DIR: stateDir });
    const load = () => loadPluginManifestRegistryCore({ env });
    const cachedPlugin = (registry: ReturnType<typeof load>) =>
      registry.plugins.find((plugin) => plugin.id === "cached-manifest");
    const first = load();

    writeManifest(pluginDir, { id: "cached-manifest", name: "After" });
    writeTextFile(pluginDir, "assets/activity.svg", "new default activity");
    fs.unlinkSync(path.join(pluginDir, "assets/activity/before.svg"));
    writeTextFile(pluginDir, "assets/activity/after.svg", "after activity");
    const updatedAt = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, updatedAt, updatedAt);

    const open = vi.spyOn(fs, "openSync");
    const second = load();
    for (const snapshot of [first, second]) {
      const plugin = cachedPlugin(snapshot);
      expect([plugin?.name, plugin?.activityIconPath]).toEqual(["Before", undefined]);
      expect(Object.keys(plugin?.toolActivityIconPaths ?? {})).toEqual(["before"]);
    }
    expect(open.mock.calls.filter(([file]) => file === manifestPath)).toEqual([]);

    const refreshedPlugin = cachedPlugin(withPluginCache(createPluginCache(), load));
    expect(refreshedPlugin).toMatchObject({
      name: "After",
      activityIconPath: path.join(pluginDir, "assets/activity.svg"),
    });
    expect(Object.keys(refreshedPlugin?.toolActivityIconPaths ?? {})).toEqual(["after"]);
    expect(open.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1);
    expect(cachedPlugin(load())?.name).toBe("Before");
  });

  it.each(["maintenance-access", "node-mcp"])(
    "loads standalone files only with an unreserved id: %s",
    (id) => {
      const dir = makeTempDir();
      const sourceName = `${id}.ts`;
      const source = path.join(dir, sourceName);
      writeTextFile(dir, sourceName, "export default { register() {} };");
      const registry = loadPluginManifestRegistryCore({
        config: { plugins: { load: { paths: [source] } } },
        candidates: [createPluginCandidate(id, dir, "config", { sourceName })],
      });
      if (id === "node-mcp") {
        expect(registry.plugins).toStrictEqual([]);
        expectRegistryDiagnosticContains(registry, 'plugin manifest id "node-mcp" is reserved');
      } else {
        expect(registry.diagnostics).toStrictEqual([]);
        expect(registry.plugins).toEqual([
          expect.objectContaining({
            id,
            source,
            manifestPath: source,
            configSchema: { type: "object", additionalProperties: false },
            activation: { onStartup: true },
          }),
        ]);
      }
    },
  );

  it("still requires manifests for explicitly configured directories", () => {
    const dir = makeTempDir();
    writeTextFile(dir, "index.ts", "export default { register() {} };");

    const registry = loadPluginManifestRegistryCore({
      config: { plugins: { load: { paths: [dir] } } },
      env: hermeticEnv(),
    });

    expect(registry.plugins.filter((plugin) => plugin.origin === "config")).toStrictEqual([]);
    expectRegistryDiagnosticContains(registry, "plugin manifest not found");
  });

  it.each(["native", "agent"] as const)(
    "discovers separate identity and activity assets in %s plugins",
    (format) => {
      const dir = makePluginDir("icon-demo", { name: "Icon Demo" });
      if (format === "agent") {
        setupBundleFixture({
          bundleDir: dir,
          manifestRelativePath: "plugin.json",
          manifest: {
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "Portable Icon Bundle",
          },
        });
      }
      writeTextFile(dir, "assets/icon.png", "portable icon");
      writeTextFile(dir, "assets/activity.svg", "default activity");
      for (const name of ["z-last", "Exact.Tool", "__proto__", "a..b"]) {
        writeTextFile(dir, `assets/activity/${name}.svg`, "tool activity");
      }
      for (const name of [
        ".hidden.svg",
        "invalid name.svg",
        "écho.svg",
        "notes.png",
        `${"a".repeat(129)}.svg`,
      ]) {
        writeTextFile(dir, `assets/activity/${name}`, "not a tool icon");
      }
      mkdirSafe(path.join(dir, "assets/activity/directory.svg"));

      const registry = loadRegistry([
        createPluginCandidate(
          "icon-demo",
          dir,
          format === "native" ? "bundled" : "global",
          format === "agent" ? { format: "bundle", bundleFormat: "agent" } : {},
        ),
      ]);

      expect(registry.plugins[0]).toMatchObject({
        iconPath: path.join(dir, "assets/icon.png"),
        activityIconPath: path.join(dir, "assets/activity.svg"),
      });
      const toolIcons = registry.plugins[0]?.toolActivityIconPaths;
      expect(Object.keys(toolIcons ?? {})).toEqual(["Exact.Tool", "__proto__", "a..b", "z-last"]);
      expect(toolIcons).toEqual(
        Object.fromEntries(
          ["Exact.Tool", "__proto__", "a..b", "z-last"].map((name) => [
            name,
            path.join(dir, `assets/activity/${name}.svg`),
          ]),
        ),
      );
    },
  );

  it.each([129])("bounds activity overrides without partially discovering %i entries", (count) => {
    const dir = makePluginDir("activity-limit");
    writeTextFile(dir, "assets/activity.svg", "default activity");
    for (let index = 0; index < count; index += 1) {
      writeTextFile(dir, `assets/activity/tool_${index}.svg`, "tool activity");
    }
    const registry = loadRegistry([createPluginCandidate("activity-limit", dir, "bundled")]);

    expect(registry.plugins[0]?.activityIconPath).toBe(path.join(dir, "assets/activity.svg"));
    expect(registry.plugins[0]?.toolActivityIconPaths).toBeUndefined();
  });

  it.each(["default-symlink", "directory-symlink", "tool-hardlink"])(
    "ignores activity assets that escape their installed plugin boundary (%s)",
    (mode) => {
      const dir = makeTempDir();
      const outside = makeTempDir();
      writeManifest(dir, { id: "activity-boundary" });
      writeTextFile(outside, "tool.svg", "external activity");
      mkdirSafe(path.join(dir, "assets"));
      try {
        if (mode === "default-symlink") {
          fs.symlinkSync(path.join(outside, "tool.svg"), path.join(dir, "assets/activity.svg"));
        } else if (mode === "directory-symlink") {
          fs.symlinkSync(outside, path.join(dir, "assets/activity"), "junction");
        } else {
          mkdirSafe(path.join(dir, "assets/activity"));
          fs.linkSync(path.join(outside, "tool.svg"), path.join(dir, "assets/activity/tool.svg"));
        }
      } catch (error) {
        if (
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "EPERM"
        ) {
          return;
        }
        throw error;
      }
      const registry = loadRegistry([createPluginCandidate("activity-boundary", dir, "global")]);

      expect(registry.plugins).toHaveLength(1);
      const plugin = registry.plugins[0];
      expect([plugin?.activityIconPath, plugin?.toolActivityIconPaths]).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it.each([
    { origins: ["bundled", "global"], winner: "bundled", level: "warn" },
    { origins: ["bundled", "global", "workspace", "config"], winner: "config", level: "info" },
    { origins: ["config", "config"], winner: "config", level: "warn" },
  ] as const)(
    "selects $winner from $origins with one $level diagnostic",
    ({ origins, winner, level }) => {
      const candidates = origins.map((origin) =>
        createPluginCandidate("test-plugin", makePluginDir("test-plugin"), origin),
      );
      const registry = loadRegistry(candidates);
      expect(registry.plugins).toEqual([expect.objectContaining({ origin: winner })]);
      expect(registry.diagnostics).toMatchObject([{ level, pluginId: "test-plugin" }]);
      expect(candidates.map((candidate) => candidate.source)).toContain(
        registry.diagnostics[0]?.source,
      );
      expect(registry.diagnostics[0]?.source).not.toBe(registry.plugins[0]?.source);
      expect(registry.diagnostics[0]?.message).toContain(registry.plugins[0]?.source);
      expectRegistryDiagnosticContains(
        registry,
        level === "info"
          ? "resolved by explicit config-selected plugin"
          : "duplicate plugin id detected",
      );
    },
  );

  it("rejects plugins whose declared ids collide after case folding", () => {
    const registry = loadRegistry([
      createPluginCandidate("Case-Collision", makePluginDir("Case-Collision"), "workspace"),
      createPluginCandidate("case-collision", makePluginDir("case-collision"), "config"),
    ]);

    expect(registry.plugins).toStrictEqual([]);
    expect(
      registry.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('collide as normalized id "case-collision"'),
      ),
    ).toHaveLength(2);
  });

  it("keeps configured same-name default-entry manifest failures distinct by full root", () => {
    const root = makeTempDir();
    const candidates = ["first", "second"].map((parent) => {
      const rootDir = path.join(root, parent, "plugin");
      mkdirSafe(rootDir);
      fs.writeFileSync(path.join(rootDir, "openclaw.plugin.json"), '{"id":', "utf-8");
      writeTextFile(rootDir, "index.js", "export default {};");
      return createPluginCandidate("index", rootDir, "config", { sourceName: "index.js" });
    });

    const registry = loadRegistry(candidates);

    expect(registry.diagnostics).toEqual(
      candidates.map((candidate) =>
        expect.objectContaining({
          level: "error",
          pluginId: "index",
          source: path.join(candidate.rootDir, "openclaw.plugin.json"),
        }),
      ),
    );
  });

  it.each([false, true])(
    "lets a recorded install override bundled candidates (reversed=%s)",
    (reverse) => {
      const bundledDir = makePluginDir("zalouser");
      const globalDir = makePluginDir("zalouser");
      const candidates = [
        createPluginCandidate("zalouser", bundledDir, "bundled"),
        createPluginCandidate("zalouser", globalDir, "global", { installOwner: "zalouser" }),
      ];
      const registry = loadPluginManifestRegistryCore({
        installRecords: { zalouser: { source: "npm", installPath: globalDir } },
        candidates: reverse ? candidates.toReversed() : candidates,
      });
      expect(countDuplicateWarnings(registry)).toBe(0);
      expect(registry.plugins).toEqual([expect.objectContaining({ origin: "global" })]);
    },
  );

  it("prefers dev dist-runtime plugins over installed globals with the same id", () => {
    const devSourceRoot = makeOpenClawDevSourceRoot();
    const bundledDir = path.join(devSourceRoot, "dist-runtime/extensions/codex");
    const globalDir = makePluginDir("codex");
    mkdirSafe(bundledDir);
    writeManifest(bundledDir, { id: "codex" });

    const registry = loadPluginManifestRegistryCore({
      env: hermeticEnv({ OPENCLAW_DEV_SOURCE_ROOT: devSourceRoot }),
      installRecords: {
        codex: { source: "npm", installPath: globalDir },
      },
      candidates: [
        createPluginCandidate("codex", bundledDir, "bundled"),
        createPluginCandidate("codex", globalDir, "global", { installOwner: "codex" }),
      ],
    });

    expect(registry.plugins).toMatchObject([{ origin: "bundled" }]);
  });

  it("associates official trust with every child owned by the installed package", () => {
    const dir = makePluginDir("diffs");
    const registry = loadPluginManifestRegistryCore({
      installRecords: {
        diffs: {
          source: "npm",
          spec: "@openclaw/diffs",
          installPath: dir,
          resolvedName: "@openclaw/diffs",
          resolvedSpec: "@openclaw/diffs@2026.7.16",
        },
      },
      candidates: ["diffs/two", "diffs/one"].map((id) =>
        Object.assign(officialCandidate("diffs", dir), { idHint: id, effectivePluginId: id }),
      ),
    });

    expect(registry.plugins).toMatchObject([
      { id: "diffs/two", trustedOfficialInstall: true },
      { id: "diffs/one", trustedOfficialInstall: true },
    ]);
    expect(registry.plugins.map(resolvePluginManifestInstallOwner)).toEqual(["diffs", "diffs"]);
  });

  it.each([
    [
      "missing npm identity",
      "npm",
      { spec: undefined, resolvedName: undefined, resolvedSpec: undefined },
    ],
    [
      "npm-pack archive metadata",
      "npm",
      { sourcePath: "/tmp/diffs.tgz", artifactKind: "npm-pack", artifactFormat: "tgz" },
    ],
    ["local source path metadata", "npm", { sourcePath: "/tmp/diffs.tgz" }],
    [
      "consistent official ClawHub source and resolution identities",
      "clawhub",
      {
        spec: "clawhub:@openclaw/msteams@2026.6.11",
        resolvedSpec: "@openclaw/msteams@2026.6.11",
        resolvedName: "@openclaw/msteams",
      },
      true,
    ],
    ["community ClawHub channel", "clawhub", { clawhubChannel: "community" }],
    ["custom ClawHub URL", "clawhub", { clawhubUrl: "https://example.invalid" }],
    ["conflicting requested spec", "clawhub", { spec: "clawhub:@openclaw/line" }],
    ["malformed ClawHub package", "clawhub", { clawhubPackage: "@openclaw/msteams@2026.6.11" }],
    ["malformed resolved spec", "clawhub", { resolvedSpec: "file:plugin.tgz" }],
    [
      "resolved identity without ClawHub source identity",
      "clawhub",
      {
        clawhubPackage: undefined,
        spec: undefined,
        resolvedSpec: "@openclaw/msteams@2026.6.11",
      },
    ],
  ] satisfies [string, "npm" | "clawhub", Partial<PluginInstallRecord>, boolean?][])(
    "checks official install trust for %s",
    (_name, source, overrides, expected?: boolean) => {
      expect(resolveOfficialTrust(source, overrides)).toBe(expected);
    },
  );

  it("binds official trust to installPath even when a stale sourcePath still matches", () => {
    const dir = makePluginDir("msteams");
    const registry = loadOfficialRegistry(
      "msteams",
      dir,
      createMsteamsClawHubInstallRecord(makeTempDir(), { sourcePath: dir }),
      ["config"],
    );
    expect(registry.plugins[0]?.trustedOfficialInstall).toBeUndefined();
    expect(registry.plugins[0]?.trust?.reason).toBe("install-path-mismatch");
  });

  it("does not trust legacy ClawHub records without source authority", () => {
    const dir = makePluginDir("diagnostics-otel");
    const registry = loadOfficialRegistry("diagnostics-otel", dir, {
      source: "clawhub",
      spec: "clawhub:@openclaw/diagnostics-otel@2026.5.18",
      installPath: dir,
    });

    expect(registry.plugins[0]?.trustedOfficialInstall).toBeUndefined();
  });

  it("preserves trusted official installs when a config path selects the installed package", () => {
    const dir = makePluginDir("diagnostics-prometheus");
    const registry = loadOfficialRegistry(
      "diagnostics-prometheus",
      dir,
      {
        source: "npm",
        installPath: dir,
        resolvedName: "@openclaw/diagnostics-prometheus",
        resolvedVersion: "2026.5.3",
      },
      ["global", "config"],
    );

    expect(registry.plugins).toMatchObject([{ origin: "config", trustedOfficialInstall: true }]);
  });

  it("does not trust unrecorded globals that spoof official ids", () => {
    const dir = makePluginDir("diagnostics-prometheus");

    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      candidates: [
        createPluginCandidate("diagnostics-prometheus", dir, "global", {
          packageName: "@openclaw/diagnostics-prometheus",
        }),
      ],
    });

    expect(registry.plugins[0]?.trustedOfficialInstall).toBeUndefined();
  });

  it("hydrates bundled channel config metadata from plugin-local config surfaces", () => {
    const manifestSchema = { type: "object", properties: { manifestOnly: { type: "boolean" } } };
    const generatedSchema = {
      type: "object",
      properties: { generatedOnly: { type: "string" } },
      additionalProperties: false,
    };
    const manifestHint = { manifestOnly: { help: "manifest hint" } };
    const generatedHint = { generatedOnly: { label: "Generated only" } };
    const dir = makePluginDir("alpha", {
      channels: ["alpha"],
      channelConfigs: { alpha: { schema: manifestSchema, uiHints: manifestHint } },
    });
    writeTextFile(dir, "index.ts", "export {};\n");
    writeTextFile(
      dir,
      "src/config-schema.js",
      `export const AlphaChannelConfigSchema = ${JSON.stringify({ schema: generatedSchema, uiHints: generatedHint })};`,
    );
    const candidate = createPluginCandidate("alpha", dir, "bundled", {
      packageDir: dir,
      packageManifest: { channel: { id: "alpha", label: "Alpha", blurb: "Alpha channel" } },
    });
    expect(loadRegistry([candidate]).plugins[0]?.channelConfigs?.alpha?.schema).toEqual(
      manifestSchema,
    );
    const registry = loadPluginManifestRegistryCore({
      bundledChannelConfigCollector: collectBundledChannelConfigsCore,
      candidates: [candidate],
    });
    const uiHints = { ...generatedHint, ...manifestHint };
    expect(registry.plugins[0]?.channelConfigs?.alpha).toEqual({
      schema: generatedSchema,
      label: "Alpha",
      description: "Alpha channel",
      uiHints,
    });
    expect(collectChannelSchemaMetadataCore(registry)).toEqual([
      {
        id: "alpha",
        label: "Alpha",
        description: "Alpha channel",
        configSchema: generatedSchema,
        configUiHints: uiHints,
      },
    ]);
  });

  it("sanitizes manifest-controlled fields in channel config descriptor diagnostics", () => {
    const dir = makeTempDir();
    const lineBreak = String.fromCharCode(10);
    const ansiRed = `${String.fromCharCode(27)}[31m`;
    writeManifest(dir, {
      id: `external${lineBreak}chat${ansiRed}`,
      channels: [`external${lineBreak}channel${ansiRed}`],
    });

    const registry = loadSingleCandidateRegistry("external-chat", dir, "global");
    const diagnostic = registry.diagnostics.find((entry) =>
      entry.message.includes("without channelConfigs metadata"),
    );

    expect(diagnostic?.pluginId).toBe("externalchat");
    expect(diagnostic?.message).toContain("externalchannel");
    expect(diagnostic?.message).not.toContain(lineBreak);
    expect(diagnostic?.message).not.toContain(ansiRed);
  });

  it.each([
    {
      id: "slack",
      channel: "slack",
      packageName: "@openclaw/slack",
      label: "Slack",
      description: "Slack channel, DM, command, and app event integration.",
      schema: undefined,
      tools: undefined,
    },
    {
      id: "wecom-openclaw-plugin",
      channel: "wecom",
      packageName: "@wecom/wecom-openclaw-plugin",
      label: "WeCom",
      description: "Enterprise WeChat conversation channel.",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { corpId: { type: "string" } },
      },
      tools: ["wecom_mcp"],
    },
  ])(
    "hydrates missing official $channel descriptors without replacing schemas",
    ({ id, channel, packageName, label, description, schema, tools }) => {
      const dir = makePluginDir(id, {
        channels: [channel],
        ...(schema ? { channelConfigs: { [channel]: { schema } } } : {}),
      });

      const registry = loadRegistry([createPluginCandidate(id, dir, "global", { packageName })]);

      const config = registry.plugins[0]?.channelConfigs?.[channel];
      expect(config).toMatchObject({ label, description });
      expect(config?.schema).toEqual(schema);
      if (tools) {
        expect(registry.plugins[0]?.contracts?.tools).toEqual(tools);
      }
      expectNoRegistryDiagnosticContains(registry, "without channelConfigs metadata");
    },
  );

  it("drops prototype-polluting channel config keys from plugin manifests", () => {
    const schema = { type: "object", additionalProperties: false };
    const dir = makePluginDir("external-chat", {
      channels: ["safe-chat"],
      channelConfigs: {
        ...Object.fromEntries(
          ["__proto__", "constructor", "prototype"].map((key) => [
            key,
            {
              schema: { type: "object", properties: { polluted: { const: true } } },
            },
          ]),
        ),
        "safe-chat": { schema },
      },
    });
    const configs = loadSingleCandidateRegistry("external-chat", dir, "global").plugins[0]
      ?.channelConfigs;
    if (!configs) {
      throw new Error("expected channel config map");
    }
    expect(Object.getPrototypeOf(configs)).toBe(null);
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(configs, key)).toBe(false);
    }
    expect(configs["safe-chat"]?.schema).toEqual(schema);
  });

  it("falls back provider catalog source from .ts to emitted .js files", () => {
    const dir = makePluginDir("anthropic-vertex", {
      providers: ["anthropic-vertex"],
      providerCatalogEntry: "./provider-discovery.ts",
    });
    fs.writeFileSync(path.join(dir, "provider-discovery.js"), "export default {};\n", "utf8");

    const registry = loadSingleCandidateRegistry("anthropic-vertex", dir, "bundled");

    expect(registry.plugins[0]?.providerDiscoverySource).toBe(
      path.join(dir, "provider-discovery.js"),
    );
  });

  it.each([
    ["relative", "js"],
    ["absolute", "js"],
    ["symlink", "js"],
    ["symlink", "ts"],
    ["hardlink", "js"],
    ["hardlink", "ts"],
  ] as const)("rejects %s provider catalog escapes through a .%s entry", (mode, extension) => {
    if (process.platform === "win32" && (mode === "symlink" || mode === "hardlink")) {
      return;
    }
    const root = makeTempDir();
    const dir = path.join(root, "plugin");
    const outsideEntry = path.join(root, "outside/provider-discovery.js");
    writeTextFile(root, "outside/provider-discovery.js", "export default {};\n");
    mkdirSafe(dir);
    if (
      (mode === "symlink" || mode === "hardlink") &&
      !linkFile(mode, outsideEntry, path.join(dir, "provider-discovery.js"))
    ) {
      return;
    }
    writeManifest(dir, {
      id: "boundary-provider",
      providers: ["boundary-provider"],
      providerCatalogEntry:
        mode === "relative"
          ? "../outside/provider-discovery.js"
          : mode === "absolute"
            ? outsideEntry
            : `./provider-discovery.${extension}`,
    });
    const registry = loadSingleCandidateRegistry(
      "boundary-provider",
      dir,
      mode === "hardlink" ? "config" : "bundled",
    );
    expect(registry.plugins[0]?.providerDiscoverySource).toBeUndefined();
    expectDiagnosticFields(registry, {
      level: "warn",
      pluginId: "boundary-provider",
      source: path.join(dir, "openclaw.plugin.json"),
      messageIncludes: "providerCatalogEntry must resolve inside the plugin root",
    });
  });

  it("normalizes media and tool metadata at the registry boundary", () => {
    const imageGenerationProviderMetadata = {
      openai: {
        aliases: ["openai"],
        authProviders: ["openai"],
        authSignals: [
          {
            provider: "openai",
            providerBaseUrl: {
              provider: "openai",
              defaultBaseUrl: "https://api.openai.com/v1",
              allowedBaseUrls: ["https://api.openai.com/v1"],
            },
          },
        ],
        configSignals: [
          {
            rootPath: "plugins.entries.openai.config",
            overlayPath: "image",
            mode: { path: "mode", default: "local", allowed: ["local"] },
            requiredAny: ["workflow", "workflowPath"],
            required: ["promptNodeId"],
          },
        ],
      },
    };
    const media = {
      capabilities: ["image", "audio"],
      defaultModels: { image: "gpt-5.4-mini", audio: "gpt-4o-transcribe" },
      autoPriority: { image: 10, audio: 20 },
      nativeDocumentInputs: ["pdf"],
      documentModels: { pdf: { textExtraction: "gpt-5.4-mini", image: false } },
    };
    const tools = {
      image_generate: {
        optional: true,
        authSignals: [{ provider: "openai" }],
        configSignals: [
          {
            rootPath: "plugins.entries.openai.config",
            overlayPath: "image",
            overlayMapPath: "accounts",
            required: ["apiKey"],
          },
        ],
      },
      memory_get: { replaySafe: true, profiles: ["coding", "messaging"] },
      memory_store: { sideEffecting: true },
    };
    const dir = makePluginDir("openai", {
      contracts: {
        mediaUnderstandingProviders: ["openai"],
        imageGenerationProviders: ["openai"],
        tools: ["image_generate", "memory_get"],
      },
      imageGenerationProviderMetadata,
      mediaUnderstandingProviderMetadata: {
        openai: {
          ...media,
          capabilities: [...media.capabilities, "unknown"],
          defaultModels: { ...media.defaultModels, unknown: "ignored" },
          autoPriority: { ...media.autoPriority, video: "ignored" },
          nativeDocumentInputs: ["pdf", "docx"],
          documentModels: {
            pdf: { ...media.documentModels.pdf, unsupported: "ignored" },
            docx: { textExtraction: "ignored" },
          },
        },
      },
      toolMetadata: {
        ...tools,
        memory_get: { ...tools.memory_get, profiles: [...tools.memory_get.profiles, "invalid"] },
      },
    });
    const plugin = loadSingleCandidateRegistry("openai", dir, "bundled").plugins[0];
    expect(plugin?.imageGenerationProviderMetadata).toEqual(imageGenerationProviderMetadata);
    expect(plugin?.mediaUnderstandingProviderMetadata).toEqual({ openai: media });
    expect(plugin?.toolMetadata).toEqual(tools);
  });

  type CompatibilityCase = Omit<Parameters<typeof compatibilityCandidate>[0], "rootDir"> & {
    version?: string;
    recorded?: boolean;
  };
  it.each<[string, CompatibilityCase, string?, string?]>([
    [
      "invalid host minimum",
      { minHostVersion: "2026.3.22" },
      "plugin manifest invalid | openclaw.install.minHostVersion must use",
    ],
    [
      "unknown host",
      { minHostVersion: ">=2026.3.22", version: "unknown" },
      "host version could not be determined",
      "warn",
    ],
    ["recorded legacy minimum", { idHint: "codex", minHostVersion: "2026.3.22", recorded: true }],
    [
      "future API",
      { pluginApi: ">=2026.5.27", version: "2026.5.10-beta.1" },
      "plugin requires plugin API >=2026.5.27",
      "warn",
    ],
    [
      "malformed API",
      { pluginApi: 20260527, version: "2026.5.27" },
      "plugin manifest invalid | package.json openclaw.compat.pluginApi must be a string",
      "error",
    ],
    ["beta on API floor", { pluginApi: ">=2026.5.27", version: "2026.5.27-beta.1" }],
    ["bundled exemption", { pluginApi: ">=2026.5.27", version: "2026.4.1", origin: "bundled" }],
  ])("enforces package compatibility: %s", (_name, params, error, level) => {
    const id = params.idHint ?? "synology-chat";
    const dir = makePluginDir(id);
    const candidate = compatibilityCandidate({ ...params, rootDir: dir });
    const registry = loadPluginManifestRegistryCore({
      installRecords: params.recorded ? { [id]: { source: "npm", installPath: dir } } : {},
      candidates: [params.recorded ? recordPluginCandidateInstallOwner(candidate, id) : candidate],
      ...(params.version ? { env: { OPENCLAW_VERSION: params.version } } : {}),
    });
    if (error) {
      expect(registry.plugins).toStrictEqual([]);
      expectRegistryDiagnosticContains(registry, error);
      if (level) {
        expectDiagnosticFields(registry, { level, messageIncludes: error });
      }
    } else {
      expect(registry.plugins.map((plugin) => plugin.id)).toEqual([id]);
      expectNoRegistryDiagnosticContains(
        registry,
        params.recorded ? "openclaw.install.minHostVersion must use" : "requires plugin API",
      );
    }
  });

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makePluginDir("feishu");
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      return;
    }

    const candidates: PluginCandidate[] = [
      createPluginCandidate("feishu", realDir, "bundled"),
      createPluginCandidate("feishu", symlinkPath, "global"),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateWarnings(registry)).toBe(0);
    expect(registry.plugins).toEqual([expect.objectContaining({ origin: "global" })]);
  });

  it("suppresses duplicate warning when global candidates come from the same package artifact", () => {
    const candidates = Array.from({ length: 2 }, () =>
      createPluginCandidate("opik-openclaw", makePluginDir("opik-openclaw"), "global", {
        packageName: "@opik/opik-openclaw",
        packageVersion: "0.2.14",
      }),
    );

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  const bundleCases: Array<{
    idHint: string;
    bundleFormat: "codex" | "claude" | "cursor";
    fixture: Omit<Parameters<typeof setupBundleFixture>[0], "bundleDir">;
    expected: Partial<
      Pick<PluginManifestRecord, "id" | "hooks" | "skills" | "settingsFiles" | "activation">
    >;
    expectedCapabilities: readonly string[];
  }> = [
    {
      idHint: "sample-bundle",
      bundleFormat: "codex",
      fixture: {
        dirs: ["skills", "hooks"],
        manifest: {
          name: "Sample Bundle",
          description: "Bundle fixture",
          skills: "skills",
          hooks: "hooks",
        },
      },
      expected: {
        id: "sample-bundle",
        hooks: ["hooks"],
        skills: ["skills"],
      },
      expectedCapabilities: ["hooks", "skills"],
    },
    {
      idHint: "claude-sample",
      bundleFormat: "claude",
      fixture: {
        dirs: ["skill-packs/starter", "commands-pack"],
        textFiles: {
          "settings.json": '{"hideThinkingBlock":true}',
        },
        manifest: {
          name: "Claude Sample",
          activation: { onStartup: false },
          skills: ["skill-packs/starter"],
          commands: "commands-pack",
        },
      },
      expected: {
        id: "claude-sample",
        skills: ["skill-packs/starter", "commands-pack"],
        settingsFiles: ["settings.json"],
        activation: { onStartup: false },
      },
      expectedCapabilities: ["skills", "commands", "settings"],
    },
    {
      idHint: "manifestless-claude",
      bundleFormat: "claude",
      fixture: {
        dirs: ["commands"],
        textFiles: {
          "settings.json": '{"hideThinkingBlock":true}',
        },
      },
      expected: {
        skills: ["commands"],
        settingsFiles: ["settings.json"],
      },
      expectedCapabilities: ["skills", "commands", "settings"],
    },
    {
      idHint: "cursor-sample",
      bundleFormat: "cursor",
      fixture: {
        dirs: ["skills", ".cursor/commands", ".cursor/rules"],
        textFiles: {
          ".cursor/hooks.json": '{"hooks":[]}',
          ".mcp.json": '{"servers":{}}',
        },
        manifest: {
          name: "Cursor Sample",
          mcpServers: "./.mcp.json",
        },
      },
      expected: {
        id: "cursor-sample",
        skills: ["skills", ".cursor/commands"],
      },
      expectedCapabilities: ["skills", "commands", "rules", "hooks", "mcpServers"],
    },
  ];
  it.each(bundleCases)(
    "loads $bundleFormat bundle $idHint",
    ({ idHint, bundleFormat, fixture, expected, expectedCapabilities }) => {
      const dir = makeTempDir();
      setupBundleFixture({
        bundleDir: dir,
        manifestRelativePath: `.${bundleFormat}-plugin/plugin.json`,
        ...fixture,
      });
      const registry = loadRegistry([
        createPluginCandidate(idHint, dir, "global", { format: "bundle", bundleFormat }),
      ]);

      expect(registry.plugins).toMatchObject([{ format: "bundle", bundleFormat, ...expected }]);
      expect(registry.plugins[0]?.bundleCapabilities).toEqual(
        expect.arrayContaining([...expectedCapabilities]),
      );
    },
  );

  it.each([
    { mode: "symlink", origin: "workspace", nix: undefined, accepted: false },
    { mode: "hardlink", origin: "workspace", nix: undefined, accepted: false },
    { mode: "hardlink", origin: "config", nix: "1", accepted: false },
    { mode: "hardlink", origin: "bundled", nix: undefined, accepted: true },
  ] as const)(
    "applies manifest link policy: $mode/$origin/nix=$nix",
    ({ mode, origin, nix, accepted }) => {
      if (mode === "hardlink" && process.platform === "win32") {
        return;
      }
      const rootDir = makeTempDir();
      const outsideDir = makePluginDir("linked");
      writeTextFile(rootDir, "index.ts", "export default function () {}");
      if (
        !linkFile(
          mode,
          path.join(outsideDir, "openclaw.plugin.json"),
          path.join(rootDir, "openclaw.plugin.json"),
        )
      ) {
        return;
      }
      const registry = loadPluginManifestRegistryCore({
        env: hermeticEnv({ OPENCLAW_NIX_MODE: nix }),
        candidates: [createPluginCandidate("linked", rootDir, origin)],
      });
      expect(registry.plugins.map((plugin) => plugin.id)).toEqual(accepted ? ["linked"] : []);
      expect(
        registry.diagnostics.some((entry) => entry.message.includes("unsafe plugin manifest path")),
      ).toBe(!accepted);
    },
  );

  it("resolves load-path manifests from the current env home", () => {
    const snapshots = ["Demo A", "Demo B"].map((name) => {
      const home = makeTempDir();
      const rootDir = path.join(home, "plugins/demo");
      mkdirSafe(rootDir);
      writeManifest(rootDir, { id: "demo", name });
      writeTextFile(rootDir, "index.ts", "export default {};");
      const registry = loadPluginManifestRegistryCore({
        config: { plugins: { load: { paths: ["~/plugins/demo"] } } },
        env: hermeticEnv({
          HOME: home,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(home, ".state"),
        }),
      });
      return { registry, rootDir };
    });
    for (const { registry, rootDir } of snapshots) {
      const plugin = registry.plugins.find((entry) => entry.id === "demo");
      if (!plugin) {
        throw new Error("expected demo manifest");
      }
      expect(fs.realpathSync(plugin.rootDir)).toBe(fs.realpathSync(rootDir));
    }
  });

  it("resolves manifests against the current host version", () => {
    const dir = makePluginDir("synology-chat");
    fs.writeFileSync(path.join(dir, "index.ts"), "export default {}", "utf-8");
    const candidates = [compatibilityCandidate({ rootDir: dir, minHostVersion: ">=2026.3.22" })];

    const loadVersion = (version: string) =>
      loadPluginManifestRegistryCore({
        candidates,
        env: hermeticEnv({ OPENCLAW_VERSION: version }),
      });
    const olderHost = loadVersion("2026.3.21");
    const newerHost = loadVersion("2026.3.22");

    expect(olderHost.plugins).toStrictEqual([]);
    expectRegistryDiagnosticContains(olderHost, "this host is 2026.3.21");
    expect(newerHost.plugins.map((plugin) => plugin.id)).toContain("synology-chat");
    expectNoRegistryDiagnosticContains(newerHost, "this host is 2026.3.21");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
