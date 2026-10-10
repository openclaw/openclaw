// Verifies plugin manifest registry construction and lookups.
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
function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-registry", tempDirs);
}

function makeOpenClawDevSourceRoot() {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf-8");
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [extensions/*]\n");
  mkdirSafe(path.join(root, "src"));
  mkdirSafe(path.join(root, "extensions"));
  return root;
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
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
      | "bundledManifest"
      | "bundledManifestPath"
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
  writeManifest(dir, { id, configSchema: { type: "object" }, ...metadata });
  return dir;
}

function createMsteamsClawHubInstallRecord(
  installPath: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  const record: PluginInstallRecord = {
    source: "clawhub",
    spec: "clawhub:@openclaw/msteams",
    installPath,
    clawhubUrl: "https://clawhub.ai",
    clawhubPackage: "@openclaw/msteams",
    clawhubChannel: "official",
  };
  return { ...record, ...overrides };
}

function resolveMsteamsClawHubTrust(overrides: Partial<PluginInstallRecord> = {}) {
  const dir = makePluginDir("msteams");
  const registry = loadPluginManifestRegistryCore({
    installRecords: {
      msteams: createMsteamsClawHubInstallRecord(dir, overrides),
    },
    candidates: [
      createPluginCandidate("msteams", dir, "global", {
        packageName: "@openclaw/msteams",
        installOwner: "msteams",
      }),
    ],
  });
  return registry.plugins[0]?.trustedOfficialInstall;
}

function resolveDiffsNpmTrust(overrides: Partial<PluginInstallRecord> = {}) {
  const dir = makePluginDir("diffs");
  const registry = loadPluginManifestRegistryCore({
    installRecords: {
      diffs: {
        source: "npm",
        spec: "@openclaw/diffs",
        installPath: dir,
        resolvedName: "@openclaw/diffs",
        resolvedVersion: "2026.7.16",
        resolvedSpec: "@openclaw/diffs@2026.7.16",
        ...overrides,
      },
    },
    candidates: [
      createPluginCandidate("diffs", dir, "global", {
        packageName: "@openclaw/diffs",
        installOwner: "diffs",
      }),
    ],
  });
  return registry.plugins[0]?.trustedOfficialInstall;
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistryCore({
    candidates,
  });
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: undefined,
    VITEST: "true",
    ...overrides,
  };
}

function countDuplicateWarnings(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "warn" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

function expectRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
  fragment: string,
) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).toContain(fragment);
}

function expectNoRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
  fragment: string,
) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(fragment);
}

function expectDiagnosticFields(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
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

function prepareLinkedManifestFixture(params: { id: string; mode: "symlink" | "hardlink" }): {
  rootDir: string;
  linked: boolean;
} {
  const rootDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
  const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
  fs.writeFileSync(
    outsideManifest,
    JSON.stringify({ id: params.id, configSchema: { type: "object" } }),
    "utf-8",
  );

  try {
    if (params.mode === "symlink") {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } else {
      fs.linkSync(outsideManifest, linkedManifest);
    }
    return { rootDir, linked: true };
  } catch (err) {
    if (params.mode === "symlink") {
      return { rootDir, linked: false };
    }
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return { rootDir, linked: false };
    }
    throw err;
  }
}

function loadSingleCandidateRegistry(
  idHint: string,
  rootDir: string,
  origin: PluginCandidate["origin"],
) {
  return loadRegistry([createPluginCandidate(idHint, rootDir, origin)]);
}

function loadRegistryForMinHostVersionCase(params: {
  rootDir: string;
  minHostVersion: string;
  env?: NodeJS.ProcessEnv;
}) {
  return loadPluginManifestRegistryCore({
    installRecords: {},
    ...(params.env ? { env: params.env } : {}),
    candidates: [
      createPluginCandidate("synology-chat", params.rootDir, "global", {
        packageDir: params.rootDir,
        packageManifest: {
          install: {
            npmSpec: "@openclaw/synology-chat",
            minHostVersion: params.minHostVersion,
          },
        },
      }),
    ],
  });
}

function loadRegistryForPluginApiCase(params: {
  rootDir: string;
  pluginApi: unknown;
  env?: NodeJS.ProcessEnv;
  origin?: "bundled" | "global" | "workspace" | "config";
  idHint?: string;
}) {
  return loadPluginManifestRegistryCore({
    installRecords: {},
    ...(params.env ? { env: params.env } : {}),
    candidates: [
      createPluginCandidate(
        params.idHint ?? "synology-chat",
        params.rootDir,
        params.origin ?? "global",
        {
          packageDir: params.rootDir,
          packageManifest: {
            install: {
              npmSpec: "@openclaw/synology-chat",
              minHostVersion: ">=2026.4.25",
            },
            compat: {
              pluginApi: params.pluginApi as string,
            },
          },
        },
      ),
    ],
  });
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
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default function () {}", "utf-8");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/cached-manifest",
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf-8",
    );
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    writeManifest(pluginDir, {
      id: "cached-manifest",
      name: "Before",
      configSchema: { type: "object" },
    });
    writeTextFile(pluginDir, "assets/activity/before.svg", "before activity");
    const env = hermeticEnv({
      OPENCLAW_STATE_DIR: stateDir,
    });

    const first = loadPluginManifestRegistryCore({ env });

    writeManifest(pluginDir, {
      id: "cached-manifest",
      name: "After",
      configSchema: { type: "object" },
    });
    writeTextFile(pluginDir, "assets/activity.svg", "new default activity");
    fs.unlinkSync(path.join(pluginDir, "assets/activity/before.svg"));
    writeTextFile(pluginDir, "assets/activity/after.svg", "after activity");
    const updatedAt = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, updatedAt, updatedAt);

    const open = vi.spyOn(fs, "openSync");
    const second = loadPluginManifestRegistryCore({ env });
    expect(first.plugins.find((plugin) => plugin.id === "cached-manifest")?.name).toBe("Before");
    expect(second.plugins.find((plugin) => plugin.id === "cached-manifest")?.name).toBe("Before");
    for (const snapshot of [first, second]) {
      const plugin = snapshot.plugins.find((entry) => entry.id === "cached-manifest");
      expect(plugin?.activityIconPath).toBeUndefined();
      expect(Object.keys(plugin?.toolActivityIconPaths ?? {})).toEqual(["before"]);
    }
    expect(open.mock.calls.filter(([file]) => file === manifestPath)).toEqual([]);

    const refreshed = withPluginCache(createPluginCache(), () =>
      loadPluginManifestRegistryCore({ env }),
    );
    expect(refreshed.plugins.find((plugin) => plugin.id === "cached-manifest")?.name).toBe("After");
    const refreshedPlugin = refreshed.plugins.find((entry) => entry.id === "cached-manifest");
    expect(refreshedPlugin?.activityIconPath).toBe(path.join(pluginDir, "assets/activity.svg"));
    expect(Object.keys(refreshedPlugin?.toolActivityIconPaths ?? {})).toEqual(["after"]);
    expect(open.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1);
    expect(
      loadPluginManifestRegistryCore({ env }).plugins.find(
        (plugin) => plugin.id === "cached-manifest",
      )?.name,
    ).toBe("Before");
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

  it("discovers separate identity and activity assets with exact, ordered tool IDs", () => {
    const dir = makePluginDir("icon-demo", { name: "Icon Demo" });
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

    const registry = loadSingleCandidateRegistry("icon-demo", dir, "bundled");

    expect(registry.plugins[0]?.iconPath).toBe(path.join(dir, "assets/icon.png"));
    expect(registry.plugins[0]?.activityIconPath).toBe(path.join(dir, "assets/activity.svg"));
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
  });

  it("discovers the same identity and activity conventions for Agent Plugins bundles", () => {
    const dir = makeTempDir();
    setupBundleFixture({
      bundleDir: dir,
      manifestRelativePath: "plugin.json",
      manifest: {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "Portable Icon Bundle",
      },
      textFiles: {
        "assets/icon.png": "portable icon",
        "assets/activity.svg": "default activity",
        "assets/activity/task.search.svg": "search activity",
      },
    });

    const registry = loadRegistry([
      createPluginCandidate("portable-icon-bundle", dir, "global", {
        format: "bundle",
        bundleFormat: "agent",
      }),
    ]);

    expect(registry.plugins[0]?.iconPath).toBe(path.join(dir, "assets/icon.png"));
    expect(registry.plugins[0]?.activityIconPath).toBe(path.join(dir, "assets/activity.svg"));
    expect(registry.plugins[0]?.toolActivityIconPaths).toEqual({
      "task.search": path.join(dir, "assets/activity/task.search.svg"),
    });
  });

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
      writeManifest(dir, { id: "activity-boundary", configSchema: { type: "object" } });
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
      expect(registry.plugins[0]?.activityIconPath).toBeUndefined();
      expect(registry.plugins[0]?.toolActivityIconPaths).toBeUndefined();
    },
  );

  it.each([
    { origins: ["bundled", "global"], winner: "bundled", level: "warn" },
    { origins: ["bundled", "global", "workspace", "config"], winner: "config", level: "info" },
    { origins: ["config", "config"], winner: "config", level: "warn" },
  ] as const)(
    "selects $winner from $origins with one $level diagnostic",
    ({ origins, winner, level }) => {
      const candidates = origins.map((origin) => {
        const rootDir = makePluginDir("test-plugin");
        return createPluginCandidate("test-plugin", rootDir, origin);
      });
      const registry = loadRegistry(candidates);
      expect(registry.plugins).toEqual([expect.objectContaining({ origin: winner })]);
      expect(registry.diagnostics).toEqual([
        expect.objectContaining({ level, pluginId: "test-plugin" }),
      ]);
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
    const upperDir = makeTempDir();
    const lowerDir = makeTempDir();
    writeManifest(upperDir, { id: "Case-Collision", configSchema: { type: "object" } });
    writeManifest(lowerDir, { id: "case-collision", configSchema: { type: "object" } });

    const registry = loadRegistry([
      createPluginCandidate("Case-Collision", upperDir, "workspace"),
      createPluginCandidate("case-collision", lowerDir, "config"),
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

  it.each(["dist-runtime/extensions"])(
    "prefers dev %s plugins over installed globals with the same id",
    (tree) => {
      const devSourceRoot = makeOpenClawDevSourceRoot();
      const bundledDir = path.join(devSourceRoot, tree, "codex");
      const globalDir = makeTempDir();
      const manifest = { id: "codex", configSchema: { type: "object" } };
      mkdirSafe(bundledDir);
      writeManifest(bundledDir, manifest);
      writeManifest(globalDir, manifest);

      const registry = loadPluginManifestRegistryCore({
        env: hermeticEnv({ OPENCLAW_DEV_SOURCE_ROOT: devSourceRoot }),
        installRecords: {
          codex: {
            source: "npm",
            installPath: globalDir,
          },
        },
        candidates: [
          createPluginCandidate("codex", bundledDir, "bundled"),
          createPluginCandidate("codex", globalDir, "global", { installOwner: "codex" }),
        ],
      });

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0]?.origin).toBe("bundled");
    },
  );

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
      candidates: [
        {
          ...createPluginCandidate("diffs/two", dir, "global", {
            packageName: "@openclaw/diffs",
            installOwner: "diffs",
          }),
          effectivePluginId: "diffs/two",
        },
        {
          ...createPluginCandidate("diffs/one", dir, "global", {
            packageName: "@openclaw/diffs",
            installOwner: "diffs",
          }),
          effectivePluginId: "diffs/one",
        },
      ],
    });

    expect(
      registry.plugins.map((plugin) => ({
        id: plugin.id,
        trustedOfficialInstall: plugin.trustedOfficialInstall,
        installOwner: resolvePluginManifestInstallOwner(plugin),
      })),
    ).toEqual([
      { id: "diffs/two", trustedOfficialInstall: true, installOwner: "diffs" },
      { id: "diffs/one", trustedOfficialInstall: true, installOwner: "diffs" },
    ]);
  });

  it.each([
    {
      name: "missing npm identity",
      overrides: { spec: undefined, resolvedName: undefined, resolvedSpec: undefined },
    },
    {
      name: "npm-pack archive metadata",
      overrides: {
        sourcePath: "/tmp/diffs.tgz",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
      },
    },
    {
      name: "local source path metadata",
      overrides: { sourcePath: "/tmp/diffs.tgz" },
    },
  ] satisfies Array<{ name: string; overrides: Partial<PluginInstallRecord> }>)(
    "does not trust official package identity from $name",
    ({ overrides }) => {
      expect(resolveDiffsNpmTrust(overrides)).toBeUndefined();
    },
  );

  it("trusts consistent official ClawHub source and resolution identities", () => {
    expect(
      resolveMsteamsClawHubTrust({
        spec: "clawhub:@openclaw/msteams@2026.6.11",
        resolvedSpec: "@openclaw/msteams@2026.6.11",
        resolvedName: "@openclaw/msteams",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "community ClawHub channel",
      overrides: { clawhubChannel: "community" },
    },
    {
      name: "custom ClawHub URL",
      overrides: { clawhubUrl: "https://example.invalid" },
    },
    {
      name: "conflicting requested spec",
      overrides: { spec: "clawhub:@openclaw/line" },
    },
    {
      name: "malformed ClawHub package",
      overrides: { clawhubPackage: "@openclaw/msteams@2026.6.11" },
    },
    {
      name: "malformed resolved spec",
      overrides: { resolvedSpec: "file:plugin.tgz" },
    },
    {
      name: "resolved identity without ClawHub source identity",
      overrides: {
        clawhubPackage: undefined,
        spec: undefined,
        resolvedSpec: "@openclaw/msteams@2026.6.11",
      },
    },
  ] satisfies Array<{ name: string; overrides: Partial<PluginInstallRecord> }>)(
    "does not trust npm-only official ClawHub installs from $name",
    ({ overrides }) => {
      expect(resolveMsteamsClawHubTrust(overrides)).toBeUndefined();
    },
  );

  it("binds official trust to installPath even when a stale sourcePath still matches", () => {
    const dir = makePluginDir("msteams");
    const registry = loadPluginManifestRegistryCore({
      installRecords: {
        msteams: createMsteamsClawHubInstallRecord(makeTempDir(), { sourcePath: dir }),
      },
      candidates: [
        createPluginCandidate("msteams", dir, "config", {
          packageName: "@openclaw/msteams",
          installOwner: "msteams",
        }),
      ],
    });
    expect(registry.plugins[0]?.trustedOfficialInstall).toBeUndefined();
    expect(registry.plugins[0]?.trust?.reason).toBe("install-path-mismatch");
  });

  it("does not trust legacy ClawHub records without source authority", () => {
    const dir = makePluginDir("diagnostics-otel");

    const registry = loadPluginManifestRegistryCore({
      installRecords: {
        "diagnostics-otel": {
          source: "clawhub",
          spec: "clawhub:@openclaw/diagnostics-otel@2026.5.18",
          installPath: dir,
        },
      },
      candidates: [
        createPluginCandidate("diagnostics-otel", dir, "global", {
          packageName: "@openclaw/diagnostics-otel",
          installOwner: "diagnostics-otel",
        }),
      ],
    });

    expect(registry.plugins[0]?.trustedOfficialInstall).toBeUndefined();
  });

  it("preserves trusted official installs when a config path selects the installed package", () => {
    const dir = makePluginDir("diagnostics-prometheus");

    const registry = loadPluginManifestRegistryCore({
      installRecords: {
        "diagnostics-prometheus": {
          source: "npm",
          installPath: dir,
          resolvedName: "@openclaw/diagnostics-prometheus",
          resolvedVersion: "2026.5.3",
        },
      },
      candidates: [
        createPluginCandidate("diagnostics-prometheus", dir, "global", {
          packageName: "@openclaw/diagnostics-prometheus",
          installOwner: "diagnostics-prometheus",
        }),
        createPluginCandidate("diagnostics-prometheus", dir, "config", {
          packageName: "@openclaw/diagnostics-prometheus",
          installOwner: "diagnostics-prometheus",
        }),
      ],
    });

    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject({ origin: "config", trustedOfficialInstall: true });
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
      configSchema: { type: "object" },
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

  it("hydrates Slack channel config metadata for lagging npm manifests", () => {
    const dir = makePluginDir("slack", { channels: ["slack"] });

    const registry = loadRegistry([
      createPluginCandidate("slack", dir, "global", { packageName: "@openclaw/slack" }),
    ]);

    const slackConfig = registry.plugins[0]?.channelConfigs?.slack;
    expect(slackConfig).toMatchObject({
      label: "Slack",
      description: "Slack channel, DM, command, and app event integration.",
    });
    // The catalog carries no schema copy: channel schemas are single-sourced
    // from the zod-derived generated bundled channel metadata (see #131292),
    // which validation seeds by channelId regardless of install origin.
    expect(slackConfig?.schema).toBeUndefined();
    expectNoRegistryDiagnosticContains(registry, "without channelConfigs metadata");
  });

  it("fills missing official external catalog descriptors for partial npm channel configs", () => {
    const dir = makePluginDir("wecom-openclaw-plugin", {
      channels: ["wecom"],
      channelConfigs: {
        wecom: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              corpId: { type: "string" },
            },
          },
        },
      },
    });

    const registry = loadRegistry([
      createPluginCandidate("wecom-openclaw-plugin", dir, "global", {
        packageName: "@wecom/wecom-openclaw-plugin",
      }),
    ]);

    expect(registry.plugins[0]?.contracts?.tools).toEqual(["wecom_mcp"]);
    expect(registry.plugins[0]?.channelConfigs?.wecom).toMatchObject({
      label: "WeCom",
      description: "Enterprise WeChat conversation channel.",
      schema: { additionalProperties: false, properties: { corpId: { type: "string" } } },
    });
    expect(registry.plugins[0]?.channelConfigs?.wecom?.schema?.properties).toEqual({
      corpId: { type: "string" },
    });
  });

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
    if (mode === "symlink" || mode === "hardlink") {
      try {
        const linkedEntry = path.join(dir, "provider-discovery.js");
        if (mode === "symlink") {
          fs.symlinkSync(outsideEntry, linkedEntry);
        } else {
          fs.linkSync(outsideEntry, linkedEntry);
        }
      } catch (error) {
        if (
          mode === "symlink" ||
          (error instanceof Error && "code" in error && error.code === "EXDEV")
        ) {
          return;
        }
        throw error;
      }
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
      configSchema: { type: "object" },
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

  it.each([
    {
      name: "rejects invalid minHostVersion metadata",
      minHostVersion: "2026.3.22",
      expectedMessage: "plugin manifest invalid | openclaw.install.minHostVersion must use",
      expectWarn: false,
    },
    {
      name: "warns distinctly when host version cannot be determined",
      minHostVersion: ">=2026.3.22",
      env: { OPENCLAW_VERSION: "unknown" } as NodeJS.ProcessEnv,
      expectedMessage: "host version could not be determined",
      expectWarn: true,
    },
  ] as const)("$name", ({ minHostVersion, env, expectedMessage, expectWarn }) => {
    const dir = makePluginDir("synology-chat");

    const registry = loadRegistryForMinHostVersionCase({
      rootDir: dir,
      minHostVersion,
      ...(env ? { env } : {}),
    });

    expect(registry.plugins).toStrictEqual([]);
    expectRegistryDiagnosticContains(registry, expectedMessage);
    if (expectWarn) {
      expect(registry.diagnostics.map((diag) => diag.level)).toContain("warn");
    }
  });

  it("accepts legacy bare minHostVersion metadata for recorded installed globals", () => {
    const dir = makePluginDir("codex");

    const registry = loadPluginManifestRegistryCore({
      installRecords: {
        codex: {
          source: "npm",
          installPath: dir,
        },
      },
      candidates: [
        {
          ...createPluginCandidate("codex", dir, "global", {
            packageDir: dir,
            packageManifest: {
              install: {
                npmSpec: "@openclaw/codex",
                minHostVersion: "2026.3.22",
              },
            },
            installOwner: "codex",
          }),
        },
      ],
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["codex"]);
    expectNoRegistryDiagnosticContains(registry, "openclaw.install.minHostVersion must use");
  });

  it.each([
    {
      name: "future range",
      pluginApi: ">=2026.5.27",
      version: "2026.5.10-beta.1",
      origin: "global",
      error: "plugin requires plugin API >=2026.5.27",
      level: "warn",
    },
    {
      name: "malformed metadata",
      pluginApi: 20260527,
      version: "2026.5.27",
      origin: "global",
      error: "plugin manifest invalid | package.json openclaw.compat.pluginApi must be a string",
      level: "error",
    },
    {
      name: "beta on API floor",
      pluginApi: ">=2026.5.27",
      version: "2026.5.27-beta.1",
      origin: "global",
      error: undefined,
      level: undefined,
    },
    {
      name: "bundled exemption",
      pluginApi: ">=2026.5.27",
      version: "2026.4.1",
      origin: "bundled",
      error: undefined,
      level: undefined,
    },
  ] as const)(
    "enforces package compatibility: $name",
    ({ pluginApi, version, origin, error, ...expected }) => {
      const dir = makePluginDir("synology-chat");
      const registry = loadRegistryForPluginApiCase({
        rootDir: dir,
        pluginApi,
        origin,
        env: { OPENCLAW_VERSION: version },
      });
      if (error) {
        expect(registry.plugins).toStrictEqual([]);
        expectDiagnosticFields(registry, { level: expected.level, messageIncludes: error });
      } else {
        expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["synology-chat"]);
        expectNoRegistryDiagnosticContains(registry, "requires plugin API");
      }
    },
  );

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makeTempDir();
    const manifest = { id: "feishu", configSchema: { type: "object" } };
    writeManifest(realDir, manifest);

    // Create a symlink pointing to the same directory
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      // On systems where symlinks are not supported (e.g. restricted Windows),
      // skip this test gracefully.
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
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const manifest = { id: "opik-openclaw", configSchema: { type: "object" } };
    writeManifest(firstDir, manifest);
    writeManifest(secondDir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate("opik-openclaw", firstDir, "global", {
        packageName: "@opik/opik-openclaw",
        packageVersion: "0.2.14",
      }),
      createPluginCandidate("opik-openclaw", secondDir, "global", {
        packageName: "@opik/opik-openclaw",
        packageVersion: "0.2.14",
      }),
    ];

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
      bundleFormat: "codex" as const,
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
      bundleFormat: "claude" as const,
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
      bundleFormat: "claude" as const,
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
      bundleFormat: "cursor" as const,
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

      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0]).toMatchObject({ format: "bundle", bundleFormat, ...expected });
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
      const fixture = prepareLinkedManifestFixture({ id: "linked", mode });
      if (!fixture.linked) {
        return;
      }
      const registry = loadPluginManifestRegistryCore({
        env: hermeticEnv({ OPENCLAW_NIX_MODE: nix }),
        candidates: [createPluginCandidate("linked", fixture.rootDir, origin)],
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
      writeManifest(rootDir, { id: "demo", name, configSchema: { type: "object" } });
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
    const candidates = [
      createPluginCandidate("synology-chat", dir, "global", {
        packageDir: dir,
        packageManifest: {
          install: {
            npmSpec: "@openclaw/synology-chat",
            minHostVersion: ">=2026.3.22",
          },
        },
      }),
    ];

    const olderHost = loadPluginManifestRegistryCore({
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.21",
      }),
    });
    const newerHost = loadPluginManifestRegistryCore({
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.22",
      }),
    });

    expect(olderHost.plugins).toStrictEqual([]);
    expectRegistryDiagnosticContains(olderHost, "this host is 2026.3.21");
    expect(newerHost.plugins.map((plugin) => plugin.id)).toContain("synology-chat");
    expectNoRegistryDiagnosticContains(newerHost, "this host is 2026.3.21");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
