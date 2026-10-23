import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import type { PackageManifest } from "./manifest.js";
import { resolvePackageSetupSource } from "./package-entry-resolution.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

vi.mock("./bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const tempDirs: string[] = [];
let testRoot: string;

const mkdirSafe = mkdirSafeDir;

function withOpenClawPackageArgv<T>(packageRoot: string, fn: () => T): T {
  mkdirSafe(path.join(packageRoot, "bin"));
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n', "utf-8");
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "node", path.join(packageRoot, "bin", "openclaw")];
  try {
    return fn();
  } finally {
    process.argv = originalArgv;
  }
}

function symlinkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

const canCreateDirectorySymlinks = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-probe-"));
  const targetDir = path.join(probeDir, "target");
  const linkDir = path.join(probeDir, "link");
  try {
    fs.mkdirSync(targetDir);
    symlinkDirectory(targetDir, linkDir);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

function discoveryEnv(root: string, overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(root, "empty-bundled-plugins");
  mkdirSafe(bundledPluginsDir);
  return {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_HOME: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS:
      overrides.OPENCLAW_BUNDLED_PLUGINS_DIR === undefined ? "1" : undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    ...overrides,
  };
}

function discover(params: Parameters<typeof discoverOpenClawPlugins>[0] = {}) {
  return discoverOpenClawPlugins({ ...params, env: discoveryEnv(testRoot) });
}

function writeJson(filePath: string, value: unknown) {
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

type PackageEntries = {
  extensions: string[];
  runtimeExtensions?: string[];
  setupEntry?: string;
  runtimeSetupEntry?: string;
  compat?: { pluginApi: unknown };
  [key: string]: unknown;
};

function writePackage(packageDir: string, packageName: unknown, openclaw: PackageEntries) {
  writeJson(path.join(packageDir, "package.json"), { name: packageName, openclaw });
}

function writeManifest(pluginDir: string, id: string, requiresPlugins?: string[]) {
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id,
    ...(requiresPlugins ? { requiresPlugins } : {}),
    configSchema: { type: "object" },
  });
}

function writeEntry(filePath: string, source = "export default function () {}") {
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, source, "utf-8");
}

function mockLinuxMountInfo(mountPoints: readonly string[]) {
  const originalReadFileSync = fs.readFileSync;
  return vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
    if (filePath === "/proc/self/mountinfo") {
      return mountPoints
        .map(
          (mountPoint, index) => `${100 + index} 99 0:${index} / ${mountPoint} rw - tmpfs tmpfs rw`,
        )
        .join("\n");
    }
    return originalReadFileSync(filePath, options as never) as never;
  });
}

function createPlugin(
  packageDir: string,
  packageName: string,
  pluginId?: string,
  entryPath = "src/index.ts",
) {
  writePackage(packageDir, packageName, { extensions: [`./${entryPath}`] });
  if (pluginId) {
    writeManifest(packageDir, pluginId);
  }
  writeEntry(path.join(packageDir, entryPath));
  if (entryPath === "src/index.ts") {
    writeEntry(path.join(packageDir, "dist/index.js"));
  }
}

function packageFixture(id: string, entries: PackageEntries, files: string[], manifest = false) {
  const pluginDir = path.join(testRoot, "extensions", id);
  writePackage(pluginDir, `@openclaw/${id}`, entries);
  if (manifest) {
    writeManifest(pluginDir, id);
  }
  for (const file of files) {
    writeEntry(path.join(pluginDir, file));
  }
  return { pluginDir };
}

function bundledFixture(id: string, installed = false) {
  const packageRoot = path.join(testRoot, "node_modules", "openclaw");
  const bundledDir = installed
    ? path.join(packageRoot, "dist", "extensions")
    : path.join(testRoot, "bundled");
  const pluginDir = path.join(bundledDir, id);
  const env = discoveryEnv(testRoot, { OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir });
  return { packageRoot, bundledDir, pluginDir, env };
}

function expectCandidateIds(
  candidates: Array<{ idHint: string }>,
  includes: readonly string[] = [],
  excludes: readonly string[] = [],
) {
  const ids = candidates.map((candidate) => candidate.idHint);
  for (const id of includes) {
    expect(ids).toContain(id);
  }
  for (const id of excludes) {
    expect(ids).not.toContain(id);
  }
}

function findCandidate<T extends { idHint?: string }>(candidates: T[], idHint: string) {
  return candidates.find((candidate) => candidate.idHint === idHint);
}

function requireCandidate<T extends { idHint?: string }>(candidates: T[], idHint: string): T {
  const candidate = findCandidate(candidates, idHint);
  if (!candidate) {
    throw new Error(`expected plugin candidate ${idHint}`);
  }
  return candidate;
}

function expectSource(
  candidates: Array<{ idHint?: string; source?: string }>,
  idHint: string,
  source: string,
) {
  const actualSource = findCandidate(candidates, idHint)?.source;
  const normalizeSource = (value: string | undefined) =>
    value && fs.existsSync(value) ? fs.realpathSync(value) : value;
  expect(normalizeSource(actualSource)).toBe(normalizeSource(source));
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics).toContainEqual(matchDiagnostic("escapes package directory"));
}

function matchDiagnostic(
  message: string,
  fields: { level?: string; pluginId?: string; source?: string } = {},
) {
  return expect.objectContaining({ ...fields, message: expect.stringContaining(message) });
}

function expectFields(candidate: object | undefined, expected: Record<string, unknown>) {
  if (!candidate) {
    throw new Error("Expected plugin candidate");
  }
  const { installOwner, installOwnerAmbiguous, ...fields } = expected;
  if (Object.hasOwn(expected, "installOwner")) {
    expect(resolvePluginCandidateInstallOwner(candidate)).toBe(installOwner);
  }
  if (Object.hasOwn(expected, "installOwnerAmbiguous")) {
    expect(isPluginCandidateInstallOwnerAmbiguous(candidate)).toBe(installOwnerAmbiguous);
  }
  expect(candidate).toMatchObject(fields);
}

function expectCandidateOrder(
  candidates: Array<{ idHint: string }>,
  expectedIds: readonly string[],
) {
  expect(candidates.map((candidate) => candidate.idHint)).toEqual(expectedIds);
}

beforeEach(() => {
  testRoot = makeTrackedTempDir("openclaw-plugins", tempDirs);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("discoverOpenClawPlugins", () => {
  it("scans configured scripts while excluding automatic helper files and non-entry scripts", () => {
    const workspaceDir = path.join(testRoot, "workspace");
    const globalRoot = path.join(testRoot, "extensions");
    const workspaceRoot = path.join(workspaceDir, ".openclaw", "extensions");
    const configuredRoot = path.join(testRoot, "configured");
    writeEntry(path.join(globalRoot, "global-helper.mjs"));
    writeEntry(path.join(workspaceRoot, "workspace-helper.js"));
    for (const [root, id] of [
      [globalRoot, "global"],
      [workspaceRoot, "workspace"],
    ] as const) {
      createPlugin(path.join(root, id), id, id, "index.js");
    }
    for (const file of ["a.d.ts", "b.d.mts", "c.d.cts", "live.test.ts", "delta.mts", "echo.cts"]) {
      writeEntry(path.join(configuredRoot, file));
    }
    const result = discover({ workspaceDir, extraPaths: [configuredRoot] });
    expectCandidateOrder(result.candidates, ["delta", "echo", "workspace", "global"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores reserved, backup, and disabled directories in scanned roots", () => {
    const workspaceDir = path.join(testRoot, "workspace");
    for (const name of [
      "node_modules",
      "dist",
      "a.backup-20260222",
      "b.disabled.20260222",
      "c.bak",
      "live",
    ]) {
      writeEntry(path.join(workspaceDir, ".openclaw", "extensions", name, "index.ts"));
    }
    const result = discover({ workspaceDir });
    expectCandidateOrder(result.candidates, ["live"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("warns only for dependencies absent from workspace and explicitly configured plugins", () => {
    const workspaceDir = path.join(testRoot, "workspace");
    const coreDir = path.join(testRoot, "configured", "core");
    const coreEntry = path.join(coreDir, "index.ts");
    writeEntry(coreEntry);
    writeManifest(coreDir, "core");
    createPlugin(
      path.join(workspaceDir, ".openclaw", "extensions", "workspace-core"),
      "workspace-core",
      "workspace-core",
    );
    const addonDir = path.join(testRoot, "extensions", "addon");
    createPlugin(addonDir, "addon", "addon");
    writeManifest(addonDir, "addon", ["workspace-core", "core", "missing"]);
    const result = discover({ workspaceDir, extraPaths: [coreEntry] });
    expectCandidateOrder(result.candidates, ["index", "workspace-core", "addon"]);
    expect(result.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "addon",
        source: path.join(addonDir, "openclaw.plugin.json"),
        message: 'plugin "addon" requires plugin "missing"; install "missing" to use it',
      },
    ]);
  });

  it("discovers bind-mounted bundled source overlays before packaged dist bundles", () => {
    const { packageRoot, pluginDir, env } = bundledFixture("synology-chat", true);
    const sourceDir = path.join(packageRoot, "extensions", "synology-chat");
    createPlugin(pluginDir, "@openclaw/synology-chat", "synology-chat", "index.js");
    createPlugin(sourceDir, "@openclaw/synology-chat", "synology-chat");
    mockLinuxMountInfo([sourceDir]);
    const { candidates, diagnostics } = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ env }),
    );
    expect(candidates.filter((entry) => entry.idHint === "synology-chat")).toMatchObject(
      (
        [
          [sourceDir, "src/index.ts"],
          [pluginDir, "index.js"],
        ] as const
      ).map(([root, entry]) => ({
        origin: "bundled",
        rootDir: fs.realpathSync(root),
        source: fs.realpathSync(path.join(root, entry)),
      })),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics).toContainEqual(
      matchDiagnostic("bind-mounted bundled plugin source overlay", {
        level: "warn",
        source: sourceDir,
      }),
    );
  });

  it("rejects pack entries whose basenames collide on the same derived id", () => {
    packageFixture(
      "pack",
      { extensions: ["./src/a/index.ts", "./src/b/index.ts"] },
      ["src/a/index.ts", "src/b/index.ts", "dist/a/index.js", "dist/b/index.js"],
      true,
    );

    const discovery = discover();
    // Neither colliding entry may silently win the shared id.
    expect(discovery.candidates.filter((c) => c.idHint === "pack/index")).toHaveLength(0);
    const collision = discovery.diagnostics.find((diag) =>
      diag.message.includes('collide on derived id "pack/index"'),
    );
    expect(collision?.level).toBe("error");
  });

  it("allows linked local install records to point at TypeScript source entries", () => {
    const { pluginDir } = packageFixture(
      "linked",
      { extensions: ["./src/index.ts"], setupEntry: "./src/setup-entry.ts" },
      ["src/index.ts", "src/setup-entry.ts"],
      true,
    );

    const installRecords = {
      linked: { source: "path", installPath: pluginDir, sourcePath: pluginDir },
    } satisfies Record<string, PluginInstallRecord>;
    const result = discover({ installRecords });

    expectSource(result.candidates, "linked", path.join(pluginDir, "src/index.ts"));
    expectFields(requireCandidate(result.candidates, "linked"), {
      setupSource: fs.realpathSync(path.join(pluginDir, "src", "setup-entry.ts")),
      installOwner: "linked",
    });
    expect(result.diagnostics).not.toContainEqual(
      matchDiagnostic("requires compiled runtime output", { pluginId: "linked" }),
    );
  });

  it.runIf(process.platform !== "win32" && canCreateDirectorySymlinks)(
    "still scans sibling package entries beside a duplicate installed file alias",
    () => {
      const firstDir = path.join(testRoot, "extensions", "first");
      const secondDir = path.join(testRoot, "extensions", "second");
      const installedFile = path.join(firstDir, "index.js");
      const aliasedFile = path.join(secondDir, "alias.js");

      writeEntry(installedFile);
      createPlugin(secondDir, "second", "second", "other.js");
      fs.symlinkSync(installedFile, aliasedFile);
      const result = discover({
        installRecords: {
          first: { source: "npm", installPath: installedFile },
          alias: { source: "npm", installPath: aliasedFile },
        },
      });
      expect(result.candidates.map((candidate) => candidate.idHint)).toEqual(["index", "second"]);
      expect(isPluginCandidateInstallOwnerAmbiguous(result.candidates[0]!)).toBe(true);
      expect(result.diagnostics).toContainEqual(
        matchDiagnostic("multiple plugin install records claim the same package path"),
      );
    },
  );

  it.runIf(canCreateDirectorySymlinks).each([
    { name: "official registry", overrides: {}, ambiguous: false, trusted: true },
    {
      name: "local archive",
      overrides: { sourcePath: "/tmp/diffs.tgz", artifactKind: "npm-pack", artifactFormat: "tgz" },
      ambiguous: false,
      trusted: undefined,
    },
    { name: "conflicting owners", overrides: {}, ambiguous: true, trusted: undefined },
  ] satisfies Array<{
    name: string;
    overrides: Partial<PluginInstallRecord>;
    ambiguous: boolean;
    trusted: true | undefined;
  }>)("preserves $name ownership through configured aliases (external package)", (scenario) => {
    const { pluginDir } = bundledFixture("diffs");
    const aliasDir = path.join(testRoot, "diffs-link");

    writePackage(pluginDir, "@openclaw/diffs", { extensions: ["./two.js", "./one.js"] });
    writeManifest(pluginDir, "diffs");
    for (const entry of ["two.js", "one.js"]) {
      fs.writeFileSync(
        path.join(pluginDir, entry),
        'throw new Error("must not evaluate metadata")',
      );
    }
    symlinkDirectory(pluginDir, aliasDir);
    const env = discoveryEnv(testRoot);
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/diffs",
      resolvedName: "@openclaw/diffs",
      resolvedSpec: "@openclaw/diffs@2026.7.16",
      installPath: pluginDir,
      ...scenario.overrides,
    };
    const installRecords = {
      diffs: record,
      ...(scenario.ambiguous ? { other: { ...record, installPath: aliasDir } } : {}),
    };
    const extraPaths = [aliasDir, pluginDir];
    const result = discoverOpenClawPlugins({ env, extraPaths, installRecords });
    const owner = scenario.ambiguous ? undefined : "diffs";
    const ids = ["diffs/two", "diffs/one"];
    expectCandidateOrder(result.candidates, ids);
    result.candidates.forEach((candidate, index) => {
      expectFields(candidate, {
        source: fs.realpathSync(path.join(pluginDir, `${ids[index]!.split("/")[1]}.js`)),
        origin: "config",
        installOwner: owner,
        installOwnerAmbiguous: scenario.ambiguous,
      });
    });
    const registry = loadPluginManifestRegistryCore({ discovery: result, installRecords, env });
    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(ids);
    for (const plugin of registry.plugins) {
      expect(resolvePluginManifestInstallOwner(plugin)).toBe(owner);
      expect(plugin.trustedOfficialInstall).toBe(scenario.trusted);
    }
    expect(result.diagnostics).toEqual(
      scenario.ambiguous
        ? [
            {
              level: "error",
              source: aliasDir,
              message:
                "multiple plugin install records claim the same package path; refresh or reinstall the package before using managed lifecycle actions",
            },
          ]
        : [],
    );
  });

  it.runIf(canCreateDirectorySymlinks)(
    "leaves explicit-only file aliases and diagnostics unfinalized",
    () => {
      const pluginDir = path.join(testRoot, "plugin");
      const aliasDir = path.join(testRoot, "alias");

      writeManifest(pluginDir, "plugin", ["missing"]);
      writeEntry(path.join(pluginDir, "index.js"));
      symlinkDirectory(pluginDir, aliasDir);
      const missing = path.join(testRoot, "missing.js");
      const loadPaths = [
        path.join(aliasDir, "index.js"),
        path.join(pluginDir, "index.js"),
        missing,
        missing,
      ];
      const env = discoveryEnv(testRoot);
      const raw = discoverConfiguredPluginLoadPaths({ env, loadPaths });
      expect(raw.candidates.map((candidate) => candidate.source)).toEqual(loadPaths.slice(0, 2));
      expect(raw.diagnostics).toMatchObject(
        [missing, missing].map((source) => ({
          level: "warn",
          source,
          code: "configured-plugin-path-unavailable",
        })),
      );
      const registry = loadPluginManifestRegistryCore({ discovery: raw, installRecords: {}, env });
      expect(registry.plugins).toHaveLength(1);
      expect(discoverOpenClawPlugins({ env, extraPaths: loadPaths }).candidates).toHaveLength(1);
    },
  );

  for (const linked of [false, true]) {
    it.runIf(!linked || canCreateDirectorySymlinks)(
      linked
        ? "keeps symlinked sourcePath managed during global scans"
        : "keeps sourcePath managed when the preferred install is missing",
      () => {
        const globalExt = path.join(testRoot, "extensions");
        const sourcePath = path.join(globalExt, "source-pack");
        const actualSource = linked ? path.join(testRoot, "checkout") : sourcePath;
        const installPath = path.join(testRoot, "installed", "source-pack");
        writePackage(actualSource, "@openclaw/source-pack", { extensions: ["./src/index.ts"] });
        writeEntry(path.join(actualSource, "src/index.ts"));
        if (linked) {
          mkdirSafe(globalExt);
          mkdirSafe(installPath);
          symlinkDirectory(actualSource, sourcePath);
        }
        const result = discover({
          installRecords: { "source-pack": { source: "path", installPath, sourcePath } },
        });
        expectCandidateIds(result.candidates, [], ["source-pack"]);
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            level: "warn",
            pluginId: "source-pack",
            source: sourcePath,
            message: expect.stringContaining("requires compiled runtime output"),
          }),
        ]);
      },
    );
  }

  it("adds managed ownership to bundled candidates deduplicated in the shared scan", () => {
    const { bundledDir, env } = bundledFixture("unused");
    const plainDir = path.join(bundledDir, "plain");
    const packageDir = path.join(bundledDir, "package");

    writeManifest(plainDir, "plain");
    writeEntry(path.join(plainDir, "index.js"));
    writePackage(packageDir, "@openclaw/package", { extensions: ["./index.js"] });
    writeManifest(packageDir, "package");
    writeEntry(path.join(packageDir, "index.js"));
    const installRecords = {
      "plain-owner": { source: "path", installPath: plainDir },
      pkg: { source: "path", installPath: packageDir },
    } satisfies Record<string, PluginInstallRecord>;

    const result = discoverOpenClawPlugins({ env, installRecords });

    expectSource(result.candidates, "plain", path.join(plainDir, "index.js"));
    expectFields(requireCandidate(result.candidates, "plain"), {
      origin: "bundled",
      packageName: undefined,
      installOwner: "plain-owner",
    });
    expectSource(result.candidates, "package", path.join(packageDir, "index.js"));
    expectFields(requireCandidate(result.candidates, "package"), {
      origin: "bundled",
      packageName: "@openclaw/package",
      installOwner: "pkg",
    });

    const ambiguous = discoverOpenClawPlugins({
      env,
      installRecords: {
        ...installRecords,
        "other-owner": installRecords["plain-owner"],
      },
    });

    expectFields(requireCandidate(ambiguous.candidates, "plain"), {
      origin: "bundled",
      installOwner: undefined,
      installOwnerAmbiguous: true,
    });
    expect(ambiguous.diagnostics).toContainEqual(
      matchDiagnostic("multiple plugin install records claim the same package path", {
        level: "error",
      }),
    );
  });

  it("uses explicit runtime extension entries for installed package plugins", () => {
    const { pluginDir } = packageFixture(
      "runtime",
      {
        extensions: ["./src/index.ts"],
        runtimeExtensions: ["./dist/index.js"],
        setupEntry: "./src/setup-entry.ts",
        runtimeSetupEntry: "./dist/setup-entry.js",
      },
      ["src/index.ts", "src/setup-entry.ts", "dist/index.js", "dist/setup-entry.js"],
    );

    const { candidates } = discover();
    const candidate = requireCandidate(candidates, "runtime");
    expectSource(candidates, "runtime", path.join(pluginDir, "dist/index.js"));
    expect(fs.realpathSync(candidate.setupSource ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist/setup-entry.js")),
    );
  });

  it.each([
    ["missing runtime output", "./src/setup-entry.ts", "src/setup-entry.ts"],
    ["escaping source before runtime output", "../src/setup-entry.ts", "dist/setup-entry.js"],
  ])("rejects setup entries with %s", (_name, source, file) => {
    packageFixture(
      "setup",
      {
        extensions: ["./dist/index.js"],
        setupEntry: source,
        runtimeSetupEntry: "./dist/setup-entry.js",
      },
      ["dist/index.js", file],
    );
    const result = discover();
    expect(requireCandidate(result.candidates, "setup").setupSource).toBeUndefined();
    if (source.startsWith("../")) {
      expectEscapesPackageDiagnostic(result.diagnostics);
    } else {
      expect(result.diagnostics).toContainEqual(
        matchDiagnostic("runtime setup entry not found: ./dist/setup-entry.js", {
          level: "error",
          pluginId: "setup",
        }),
      );
    }
  });

  it.each([
    ["plugin", "channel", "plugin"],
    [42, "channel", "channel"],
    [{ invalid: true }, false, undefined],
  ] as const)(
    "normalizes setup owner metadata for callers without a prepared owner: %j",
    (pluginMetadataId, channelMetadataId, owner) => {
      const pluginDir = testRoot;
      const diagnostics: ReturnType<typeof discoverOpenClawPlugins>["diagnostics"] = [];
      const manifest = {
        openclaw: {
          setupEntry: "./missing-setup.js",
          plugin: { id: pluginMetadataId },
          channel: { id: channelMetadataId },
        },
      };

      expect(
        resolvePackageSetupSource({
          packageDir: pluginDir,
          manifest: manifest as unknown as PackageManifest,
          origin: "global",
          sourceLabel: pluginDir,
          diagnostics,
        }),
      ).toBeNull();
      expect(diagnostics).toEqual([
        expect.objectContaining({
          level: "error",
          ...(owner ? { pluginId: owner } : {}),
        }),
      ]);
      if (!owner) {
        expect(diagnostics[0]).not.toHaveProperty("pluginId");
      }
    },
  );

  it.each([
    ["plugin", "@openclaw/package-name-owner", { plugin: { id: "plugin" } }, { idHint: "plugin" }],
    [
      "channel",
      "@scope/",
      { channel: { id: "channel" } },
      { idHint: "owner-root", diagnosticIdHint: "channel" },
    ],
  ] as const)(
    "preserves %s ownership when the manifest is malformed",
    (owner, packageName, metadata, expected) => {
      const pluginDir = path.join(testRoot, "extensions", "owner-root");
      writePackage(pluginDir, packageName, { extensions: ["./index.js"], ...metadata });
      fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
      writeEntry(path.join(pluginDir, "index.js"));
      const discovery = discover();
      const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });
      expect(discovery.candidates).toEqual([expect.objectContaining(expected)]);
      expect(registry.diagnostics).toEqual([
        expect.objectContaining({ level: "error", pluginId: owner }),
      ]);
    },
  );

  it("retains every owner when invalid package extension diagnostics are deduplicated", () => {
    for (const [packageName, pluginId, explicitOwner] of [
      [undefined, "blank-one", undefined],
      [42, "blank-two", undefined],
      ["@openclaw/example-plugin", "example", undefined],
      ["@openclaw/manifest-derived-package", "manifest", "manifest"],
      ["@openclaw/channel-derived-package", "channel", "channel"],
    ] as const) {
      const pluginDir = path.join(testRoot, "extensions", pluginId);

      writePackage(pluginDir, packageName, {
        extensions: ["./dist/index.js", " "],
        ...(explicitOwner === "channel" ? { channel: { id: pluginId } } : {}),
      });
      writeEntry(path.join(pluginDir, "dist", "index.js"));
      if (explicitOwner === "manifest") {
        writeManifest(pluginDir, pluginId);
      }
    }

    const discovery = discover();
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });
    const errors = registry.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("openclaw.extensions[1]"),
    );

    expect(errors).toHaveLength(5);
    expect(errors).toEqual(
      expect.arrayContaining(
        ["blank-one", "blank-two", "example", "manifest", "channel"].map((pluginId) =>
          expect.objectContaining({ level: "error", pluginId }),
        ),
      ),
    );
  });

  it.each([
    ["@openclaw/pkg", "manifest", "plugin", "channel", ">=2026.5.27-beta.2", "manifest"],
    ["@openclaw/pkg", undefined, 42, "channel", 20260527, "channel"],
    [false, undefined, { invalid: true }, ["invalid"], 20260527, "compat"],
  ] as const)(
    "attributes incompatible package API diagnostics for %j",
    (packageName, manifestId, packagePluginId, packageChannelId, pluginApi, expectedOwner) => {
      const pluginDir = path.join(testRoot, "extensions", "compat");

      writePackage(pluginDir, packageName, {
        extensions: [" "],
        plugin: { id: packagePluginId },
        channel: { id: packageChannelId },
        compat: { pluginApi },
      });
      if (manifestId) {
        writeManifest(pluginDir, manifestId);
      }

      const result = discoverOpenClawPlugins({
        env: discoveryEnv(testRoot, { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1" }),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: "warn", pluginId: expectedOwner }),
      );
      expect(result.diagnostics).not.toContainEqual(matchDiagnostic("openclaw.extensions"));
    },
  );

  it("keeps trusted bundled package fallback from missing TypeScript metadata to JavaScript", () => {
    const { pluginDir, env } = bundledFixture("downloadable");

    writePackage(pluginDir, "@openclaw/downloadable", {
      extensions: ["./index.ts"],
      compat: { pluginApi: ">=2099.1.1" },
    });
    writeManifest(pluginDir, "downloadable");
    writeEntry(path.join(pluginDir, "index.js"));

    const { candidates, diagnostics } = discoverOpenClawPlugins({ env });

    expectSource(candidates, "downloadable", path.join(pluginDir, "index.js"));
    expect(diagnostics).toStrictEqual([]);
  });

  it("discovers source-checkout-only bundled plugins alongside built bundled plugins", () => {
    const packageRoot = path.join(testRoot, "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const sourceDir = path.join(packageRoot, "extensions");
    const builtPluginDir = path.join(bundledDir, "shipped");
    const sourceBuiltPluginDir = path.join(sourceDir, "shipped");
    const sourceOnlyPluginDir = path.join(sourceDir, "downloadable");
    mkdirSafe(path.join(packageRoot, "src"));

    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf-8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");

    for (const [root, id, entry] of [
      [builtPluginDir, "shipped", "index.js"],
      [sourceBuiltPluginDir, "shipped", "index.ts"],
      [sourceOnlyPluginDir, "downloadable", "index.ts"],
    ] as const) {
      createPlugin(root, `@openclaw/${id}`, id, entry);
    }

    const { candidates } = discoverOpenClawPlugins({
      env: discoveryEnv(testRoot, { OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir }),
    });

    expectCandidateIds(candidates, ["shipped", "downloadable"]);
    expectSource(candidates, "shipped", path.join(builtPluginDir, "index.js"));
    expectSource(candidates, "downloadable", path.join(sourceOnlyPluginDir, "index.ts"));
  });

  it.each([
    [
      "agent",
      "portable-bundle",
      "plugin.json",
      "skills/sample",
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "portable-bundle",
      },
    ],
    ["claude", "claude-bundle", "settings.json", "commands", { hideThinkingBlock: true }],
    [
      "cursor",
      "cursor-bundle",
      ".cursor-plugin/plugin.json",
      ".cursor/commands",
      { name: "Cursor Bundle" },
    ],
  ] as const)(
    "discovers %s bundles from their metadata and default layout",
    (format, id, marker, directory, manifest) => {
      const bundleDir = path.join(testRoot, "extensions", id);
      writeJson(path.join(bundleDir, marker), manifest);
      mkdirSafe(path.join(bundleDir, directory));
      const bundle = requireCandidate(discover().candidates, id);
      expect(bundle).toMatchObject({
        idHint: id,
        format: "bundle",
        bundleFormat: format,
        source: bundleDir,
        rootDir: fs.realpathSync(bundleDir),
      });
    },
  );

  it("preserves the package install owner for managed bundle candidates", () => {
    const bundleDir = path.join(testRoot, "extensions", "pkg");
    writeJson(path.join(bundleDir, ".codex-plugin/plugin.json"), {
      name: "runtime-child",
      skills: "skills",
    });
    mkdirSafe(path.join(bundleDir, "skills"));

    const { candidates } = discover({
      installRecords: {
        pkg: { source: "path", sourcePath: bundleDir, installPath: bundleDir },
      },
    });

    expectFields(requireCandidate(candidates, "runtime-child"), { installOwner: "pkg" });
  });

  it("falls back to the native index when a configured bundle sidecar is malformed", () => {
    const pluginDir = path.join(testRoot, "plugins", "bad-bundle");
    const marker = path.join(pluginDir, ".codex-plugin", "plugin.json");
    writeEntry(path.join(pluginDir, "index.ts"));
    writeEntry(marker, "{");
    const result = discover({ extraPaths: [pluginDir] });
    expect(findCandidate(result.candidates, "bad-bundle")?.format).toBe("openclaw");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ source: marker }));
  });

  type EscapeFixture = [
    name: string,
    entry: string,
    files: string[],
    links?: { runtime?: string; symlink?: [string, string]; hardlink?: [string, string] },
  ];
  it.each<EscapeFixture>([
    [
      "blocks extension entries that escape package directory",
      "../../outside.js",
      ["../../outside.js"],
    ],
    [
      "blocks escaping source entries before explicit runtime entries",
      "../src/index.ts",
      ["dist/index.js"],
      { runtime: "./dist/index.js" },
    ],
    [
      "rejects package extension entries that escape via symlink",
      "./linked/escape.ts",
      ["../../outside/escape.ts"],
      { symlink: ["../../outside", "linked"] },
    ],
    [
      "rejects hardlinked TypeScript entries before built runtime inference",
      "./escape.ts",
      ["../../outside/escape.ts", "dist/escape.js"],
      { hardlink: ["../../outside/escape.ts", "escape.ts"] },
    ],
    [
      "rejects hardlinked inferred built runtime entries instead of falling back to source",
      "./src/index.ts",
      ["src/index.ts", "../../outside/index.js"],
      { hardlink: ["../../outside/index.js", "dist/index.js"] },
    ],
  ])("%s", (_name, entry, files, links = {}) => {
    const { hardlink, symlink, runtime } = links;
    if (hardlink && process.platform === "win32") {
      return;
    }

    const pluginDir = path.join(testRoot, "extensions", "pack");
    writePackage(pluginDir, "@openclaw/pack", {
      extensions: [entry],
      ...(runtime ? { runtimeExtensions: [runtime] } : {}),
    });
    for (const file of files) {
      writeEntry(path.join(pluginDir, file));
    }
    if (symlink) {
      try {
        symlinkDirectory(path.join(pluginDir, symlink[0]), path.join(pluginDir, symlink[1]));
      } catch {
        return;
      }
    }
    if (hardlink) {
      const target = path.join(pluginDir, hardlink[1]);
      mkdirSafe(path.dirname(target));
      try {
        fs.linkSync(path.join(pluginDir, hardlink[0]), target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EXDEV") {
          return;
        }
        throw error;
      }
    }
    const result = discover();
    expect(result.candidates).toEqual([]);
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("ignores package manifests that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const globalExt = path.join(testRoot, "extensions", "pack");
    const outsideDir = path.join(testRoot, "outside");
    const outsideManifest = path.join(outsideDir, "package.json");
    const linkedManifest = path.join(globalExt, "package.json");
    mkdirSafe(globalExt);

    writeEntry(path.join(globalExt, "entry.ts"), "export default {}");
    writeJson(outsideManifest, {
      name: "@openclaw/pack",
      openclaw: { extensions: ["./entry.ts"] },
    });
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const { candidates } = discover();

    expect(candidates.map((candidate) => candidate.idHint)).not.toContain("pack");
  });

  it.runIf(process.platform !== "win32").each(["configured", "automatic"] as const)(
    "repairs a world-writable bundled plugin without blocked warnings via %s discovery",
    (selection) => {
      const { packageRoot, bundledDir, pluginDir } = bundledFixture("repairable", true);
      createPlugin(pluginDir, "repairable", undefined, "index.js");
      fs.chmodSync(pluginDir, 0o777);
      const result = withOpenClawPackageArgv(packageRoot, () =>
        discoverOpenClawPlugins({
          env: discoveryEnv(testRoot, {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: selection === "configured" ? bundledDir : undefined,
          }),
          extraPaths: selection === "configured" ? [pluginDir, pluginDir] : [],
        }),
      );
      expect(result.candidates).toHaveLength(1);
      expectFields(result.candidates[0]!, { idHint: "repairable", origin: "bundled" });
      expect(result.diagnostics).toEqual([]);
      expect(fs.statSync(pluginDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(canCreateDirectorySymlinks)(
    "does not grant bundled provenance to an outside package symlink",
    () => {
      const { bundledDir, env } = bundledFixture("unused");
      const outsideDir = path.join(testRoot, "outside");
      mkdirSafe(bundledDir);
      createPlugin(outsideDir, "@openclaw/codex", "codex", "index.js");
      symlinkDirectory(outsideDir, path.join(bundledDir, "codex"));
      for (const extraPaths of [[], [outsideDir]]) {
        const result = discoverOpenClawPlugins({ env, extraPaths });
        expect(result.candidates).toHaveLength(extraPaths.length);
        expect(result.candidates.every((candidate) => candidate.origin === "config")).toBe(true);
        expect(result.diagnostics).toContainEqual(matchDiagnostic("escapes bundled root"));
      }
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "blocks suspicious ownership when uid mismatch is detected",
    () => {
      createPlugin(
        path.join(testRoot, "extensions", "owner-mismatch"),
        "@openclaw/owner-mismatch",
        "owner-mismatch",
      );

      const actualUid = (process as NodeJS.Process & { getuid: () => number }).getuid();
      using _ = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
      const result = discover();
      const shouldBlockForMismatch = actualUid !== 0;
      expect(result.candidates).toHaveLength(shouldBlockForMismatch ? 0 : 1);
      expect(
        result.diagnostics.some(({ message }) => message.includes("suspicious ownership")),
      ).toBe(shouldBlockForMismatch);
      if (shouldBlockForMismatch) {
        expect(result.diagnostics).toContainEqual(
          matchDiagnostic("suspicious ownership", { pluginId: "owner-mismatch" }),
        );
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses native manifest ids for blocked index-file directory diagnostics",
    () => {
      const pluginDir = path.join(testRoot, "alias-dir");

      writeManifest(pluginDir, "actual-id");
      writeEntry(path.join(pluginDir, "index.ts"));
      fs.chmodSync(pluginDir, 0o777);

      try {
        const result = discover({ extraPaths: [pluginDir] });
        expect(result.candidates).toHaveLength(0);
        expect(result.diagnostics).toContainEqual(
          matchDiagnostic("blocked plugin candidate: world-writable path", {
            pluginId: "actual-id",
            source: pluginDir,
          }),
        );
      } finally {
        fs.chmodSync(pluginDir, 0o755);
      }
    },
  );

  it("refreshes same-size bundled package manifests when plugin metadata is reloaded", () => {
    const { pluginDir, env } = bundledFixture("cached");
    createPlugin(pluginDir, "@openclaw/cache-one", "cached", "index.js");
    const packageManifestPath = path.join(pluginDir, "package.json");
    const unchangedTimestamp = new Date("2025-01-01T00:00:00.000Z");
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);

    const workspaceA = path.join(testRoot, "workspace-a");
    const workspaceB = path.join(testRoot, "workspace-b");
    const first = discoverOpenClawPlugins({ env, workspaceDir: workspaceA });
    expect(requireCandidate(first.candidates, "cached").packageName).toBe("@openclaw/cache-one");
    const originalStat = fs.statSync(packageManifestPath);
    writePackage(pluginDir, "@openclaw/cache-two", { extensions: ["./index.js"] });
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);
    const replacementStat = fs.statSync(packageManifestPath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

    const beforeReload = discoverOpenClawPlugins({ env, workspaceDir: workspaceB });
    expect(requireCandidate(beforeReload.candidates, "cached").packageName).toBe(
      "@openclaw/cache-one",
    );

    clearPluginMetadataLifecycleCaches();

    const afterReload = discoverOpenClawPlugins({ env, workspaceDir: workspaceB });
    expect(requireCandidate(afterReload.candidates, "cached").packageName).toBe(
      "@openclaw/cache-two",
    );
  });

  it("keeps configured selection and installed ownership isolated across workspace scans", () => {
    const { packageRoot, pluginDir: bundledPlugin, env } = bundledFixture("shared", true);
    const installedPlugin = path.join(testRoot, "installed", "shared");
    for (const packageDir of [bundledPlugin, installedPlugin]) {
      createPlugin(packageDir, "@openclaw/shared", "shared", "index.js");
    }
    const installRecords: Record<string, PluginInstallRecord> = {
      "installed-owner": {
        source: "path",
        installPath: installedPlugin,
        sourcePath: installedPlugin,
      },
    };
    withOpenClawPackageArgv(packageRoot, () => {
      const read = (workspaceDir?: string, extraPaths: string[] = []) => {
        const discovery = discoverOpenClawPlugins({
          env,
          workspaceDir,
          extraPaths,
          installRecords,
        });
        const registry = loadPluginManifestRegistryCore({
          env,
          workspaceDir,
          installRecords,
          discovery,
          config: { plugins: { load: { paths: extraPaths } } },
        });
        const winner = registry.plugins.find((plugin) => plugin.id === "shared");
        if (!winner) {
          throw new Error("Expected a selected shared manifest");
        }
        return { discovery, winner };
      };
      const initial = read();
      expect(initial.winner.rootDir).toBe(fs.realpathSync(installedPlugin));
      const workspaceA = path.join(testRoot, "workspace-a");
      const selected = read(workspaceA, [bundledPlugin]);
      expect(selected.winner.rootDir).toBe(fs.realpathSync(bundledPlugin));
      expect(selected.winner.sourcePreferred).toBe(true);
      const workspaceB = path.join(testRoot, "workspace-b");
      const ordinary = read(workspaceB);
      expect(ordinary.winner.rootDir).toBe(fs.realpathSync(installedPlugin));
      expect(resolvePluginManifestInstallOwner(ordinary.winner)).toBe("installed-owner");
      for (const [result, workspaceDir] of [
        [initial, undefined],
        [selected, workspaceA],
        [ordinary, workspaceB],
      ] as const) {
        const installed = result.discovery.candidates.find(
          (candidate) => candidate.origin === "global",
        );
        expectFields(installed, { workspaceDir, installOwner: "installed-owner" });
      }
      expect(selected.winner.sourcePreferred).toBe(true);
      expect(ordinary.winner.sourcePreferred).toBeUndefined();
    });
  });

  it("discovers bundled and global plugins for each workspace-specific scan", () => {
    const packageRoot = path.join(testRoot, "node_modules", "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const globalExt = path.join(testRoot, "extensions");
    const workspaceA = path.join(testRoot, "workspace-a");
    const workspaceB = path.join(testRoot, "workspace-b");

    for (const [root, id] of [
      [bundledDir, "bundled-plugin"],
      [globalExt, "global-plugin"],
      [path.join(workspaceA, ".openclaw", "extensions"), "workspace-a"],
      [path.join(workspaceB, ".openclaw", "extensions"), "workspace-b"],
    ] as const) {
      createPlugin(path.join(root, id), `@openclaw/${id}`, id);
    }

    const env = {
      ...discoveryEnv(testRoot),
      HOME: testRoot,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    };
    const first = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ workspaceDir: "~/workspace-a", env }),
    );
    expectCandidateIds(
      first.candidates,
      ["bundled-plugin", "global-plugin", "workspace-a"],
      ["workspace-b"],
    );

    const second = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ workspaceDir: workspaceB, env }),
    );
    expectCandidateIds(
      second.candidates,
      ["bundled-plugin", "global-plugin", "workspace-b"],
      ["workspace-a"],
    );

    const bundledOnly = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({
        workspaceDir: workspaceA,
        extraPaths: [path.join(testRoot, "missing-configured-plugin")],
        installRecords: { missing: { source: "npm", installPath: testRoot } },
        rootScope: "bundled",
        env,
      }),
    );
    expect(bundledOnly.candidates.map((candidate) => candidate.idHint)).toEqual(["bundled-plugin"]);
    expect(bundledOnly.diagnostics).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
