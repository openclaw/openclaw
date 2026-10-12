import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugins", tempDirs);
}

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

function buildDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(stateDir, "empty-bundled-plugins");
  mkdirSafe(bundledPluginsDir);
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
  };
}

function buildDiscoveryEnvWithOverrides(
  stateDir: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const enablesBundledOverride =
    Object.hasOwn(overrides, "OPENCLAW_BUNDLED_PLUGINS_DIR") &&
    overrides.OPENCLAW_BUNDLED_PLUGINS_DIR !== undefined;
  return {
    ...buildDiscoveryEnv(stateDir),
    ...(enablesBundledOverride ? { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined } : {}),
    ...overrides,
  };
}

function discoverWithStateDir(
  stateDir: string,
  params: Parameters<typeof discoverOpenClawPlugins>[0] = {},
) {
  return discoverOpenClawPlugins({ ...params, env: buildDiscoveryEnv(stateDir) });
}

function writeJson(filePath: string, value: unknown) {
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

function writePluginPackageManifest({
  packageDir,
  packageName,
  ...openclaw
}: {
  packageDir: string;
  packageName: string;
  extensions: string[];
  runtimeExtensions?: string[];
  setupEntry?: string;
  runtimeSetupEntry?: string;
}) {
  writeJson(path.join(packageDir, "package.json"), { name: packageName, openclaw });
}

function writePluginManifest({
  pluginDir,
  ...manifest
}: {
  pluginDir: string;
  id: string;
  requiresPlugins?: string[];
}) {
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    ...manifest,
    configSchema: { type: "object" },
  });
}

function writePluginEntry(filePath: string, source = "export default function () {}") {
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

function createPackagePluginWithEntry(
  packageDir: string,
  packageName: string,
  pluginId?: string,
  entryPath = "src/index.ts",
) {
  writePluginPackageManifest({ packageDir, packageName, extensions: [`./${entryPath}`] });
  if (pluginId) {
    writePluginManifest({ pluginDir: packageDir, id: pluginId });
  }
  writePluginEntry(path.join(packageDir, entryPath));
  if (entryPath === "src/index.ts") {
    writePluginEntry(path.join(packageDir, "dist/index.js"));
  }
}

function expectCandidateIds(
  candidates: Array<{ idHint: string }>,
  params: { includes?: readonly string[]; excludes?: readonly string[] },
) {
  const ids = candidates.map((candidate) => candidate.idHint);
  params.includes?.forEach((includedId) => {
    expect(ids).toContain(includedId);
  });
  params.excludes?.forEach((excludedId) => {
    expect(ids).not.toContain(excludedId);
  });
}

function findCandidateById<T extends { idHint?: string }>(candidates: T[], idHint: string) {
  return candidates.find((candidate) => candidate.idHint === idHint);
}

function requireCandidateById<T extends { idHint?: string }>(candidates: T[], idHint: string): T {
  const candidate = findCandidateById(candidates, idHint);
  if (!candidate) {
    throw new Error(`expected plugin candidate ${idHint}`);
  }
  return candidate;
}

function expectCandidateSource(
  candidates: Array<{ idHint?: string; source?: string }>,
  idHint: string,
  source: string,
) {
  const actualSource = findCandidateById(candidates, idHint)?.source;
  const normalizeSource = (value: string | undefined) =>
    value && fs.existsSync(value) ? fs.realpathSync(value) : value;
  expect(normalizeSource(actualSource)).toBe(normalizeSource(source));
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
    true,
  );
}

type DiagnosticFilter = {
  diagnostics: ReturnType<typeof discoverOpenClawPlugins>["diagnostics"];
  messageIncludes: string;
  level?: string;
  pluginId?: string;
  source?: string;
};

function expectDiagnostic({ diagnostics, messageIncludes, ...fields }: DiagnosticFilter) {
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ ...fields, message: expect.stringContaining(messageIncludes) }),
  );
}

function expectNoDiagnostic({ diagnostics, messageIncludes, ...fields }: DiagnosticFilter) {
  expect(diagnostics).not.toContainEqual(
    expect.objectContaining({ ...fields, message: expect.stringContaining(messageIncludes) }),
  );
}

function expectCandidateFields(candidate: object | undefined, expected: Record<string, unknown>) {
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

function expectCandidatePresence(
  result: ReturnType<typeof discoverOpenClawPlugins>,
  params: { present?: readonly string[]; absent?: readonly string[] },
) {
  expectCandidateIds(result.candidates, { includes: params.present, excludes: params.absent });
}

function expectCandidateOrder(
  candidates: Array<{ idHint: string }>,
  expectedIds: readonly string[],
) {
  expect(candidates.map((candidate) => candidate.idHint)).toEqual(expectedIds);
}

function discoverOverlayFixture() {
  const stateDir = makeTempDir();
  const packageRoot = path.join(stateDir, "node_modules", "openclaw");
  const bundledRoot = path.join(packageRoot, "dist", "extensions");
  const bundledPluginDir = path.join(bundledRoot, "synology-chat");
  const sourcePluginDir = path.join(packageRoot, "extensions", "synology-chat");
  createPackagePluginWithEntry(
    bundledPluginDir,
    "@openclaw/synology-chat",
    "synology-chat",
    "index.js",
  );
  createPackagePluginWithEntry(sourcePluginDir, "@openclaw/synology-chat", "synology-chat");
  mockLinuxMountInfo([sourcePluginDir]);
  const sourceEntryPath = path.join(sourcePluginDir, "src", "index.ts");
  const bundledEntryPath = path.join(bundledPluginDir, "index.js");

  const { candidates, diagnostics } = withOpenClawPackageArgv(packageRoot, () =>
    discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      },
    }),
  );

  return {
    candidates,
    diagnostics,
    sourcePluginDir,
    bundledPluginDir,
    sourceEntryPath,
    bundledEntryPath,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("discoverOpenClawPlugins", () => {
  it("scans configured scripts while excluding automatic helper files and non-entry scripts", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const globalRoot = path.join(stateDir, "extensions");
    const workspaceRoot = path.join(workspaceDir, ".openclaw", "extensions");
    const configuredRoot = path.join(stateDir, "configured");
    writePluginEntry(path.join(globalRoot, "global-helper.mjs"));
    writePluginEntry(path.join(workspaceRoot, "workspace-helper.js"));
    createPackagePluginWithEntry(
      path.join(globalRoot, "global-plugin"),
      "global-plugin",
      "global-plugin",
      "index.js",
    );
    createPackagePluginWithEntry(
      path.join(workspaceRoot, "workspace-plugin"),
      "workspace-plugin",
      "workspace-plugin",
      "index.js",
    );
    for (const file of [
      "alpha.d.ts",
      "bravo.d.mts",
      "charlie.d.cts",
      "live.test.ts",
      "delta.mts",
      "echo.cts",
    ]) {
      writePluginEntry(path.join(configuredRoot, file));
    }
    const result = discoverOpenClawPlugins({
      workspaceDir,
      extraPaths: [configuredRoot],
      env: buildDiscoveryEnv(stateDir),
    });
    expectCandidateOrder(result.candidates, ["delta", "echo", "workspace-plugin", "global-plugin"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores reserved, backup, and disabled directories in scanned roots", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    for (const name of [
      "node_modules",
      "dist",
      "feishu.backup-20260222",
      "telegram.disabled.20260222",
      "discord.bak",
      "live",
    ]) {
      writePluginEntry(path.join(workspaceDir, ".openclaw", "extensions", name, "index.ts"));
    }
    const result = discoverOpenClawPlugins({ workspaceDir, env: buildDiscoveryEnv(stateDir) });
    expectCandidateOrder(result.candidates, ["live"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("warns only for dependencies absent from workspace and explicitly configured plugins", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const coreDir = path.join(stateDir, "configured", "core");
    const coreEntry = path.join(coreDir, "index.ts");
    writePluginEntry(coreEntry);
    writePluginManifest({ pluginDir: coreDir, id: "core" });
    createPackagePluginWithEntry(
      path.join(workspaceDir, ".openclaw", "extensions", "workspace-core"),
      "workspace-core",
      "workspace-core",
    );
    const addonDir = path.join(stateDir, "extensions", "addon");
    createPackagePluginWithEntry(addonDir, "addon", "addon");
    writePluginManifest({
      pluginDir: addonDir,
      id: "addon",
      requiresPlugins: ["workspace-core", "core", "missing"],
    });
    const result = discoverOpenClawPlugins({
      workspaceDir,
      extraPaths: [coreEntry],
      env: buildDiscoveryEnv(stateDir),
    });
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
    const {
      candidates,
      diagnostics,
      sourcePluginDir,
      bundledPluginDir,
      sourceEntryPath,
      bundledEntryPath,
    } = discoverOverlayFixture();
    const synologyCandidates = candidates.filter(
      (candidate) => candidate.idHint === "synology-chat",
    );
    expect(synologyCandidates).toHaveLength(2);
    expectCandidateFields(synologyCandidates[0], {
      origin: "bundled",
      rootDir: fs.realpathSync(sourcePluginDir),
      source: fs.realpathSync(sourceEntryPath),
    });
    expectCandidateFields(synologyCandidates[1], {
      origin: "bundled",
      rootDir: fs.realpathSync(bundledPluginDir),
      source: fs.realpathSync(bundledEntryPath),
    });
    expect(diagnostics).toHaveLength(1);
    expectDiagnostic({
      diagnostics,
      level: "warn",
      source: sourcePluginDir,
      messageIncludes: "bind-mounted bundled plugin source overlay",
    });
  });

  it("rejects pack entries whose basenames collide on the same derived id", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "pack",
      extensions: ["./src/a/index.ts", "./src/b/index.ts"],
    });
    writePluginManifest({ pluginDir: globalExt, id: "pack" });
    writePluginEntry(path.join(globalExt, "src", "a", "index.ts"));
    writePluginEntry(path.join(globalExt, "src", "b", "index.ts"));
    writePluginEntry(path.join(globalExt, "dist", "a", "index.js"));
    writePluginEntry(path.join(globalExt, "dist", "b", "index.js"));

    const discovery = discoverWithStateDir(stateDir, {});
    // Neither colliding entry may silently win the shared id.
    expect(discovery.candidates.filter((c) => c.idHint === "pack/index")).toHaveLength(0);
    const collision = discovery.diagnostics.find((diag) =>
      diag.message.includes('collide on derived id "pack/index"'),
    );
    expect(collision?.level).toBe("error");
  });

  it("allows linked local install records to point at TypeScript source entries", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "linked-source-pack");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/linked-source-pack",
      extensions: ["./src/index.ts"],
      setupEntry: "./src/setup-entry.ts",
    });
    writePluginManifest({ pluginDir, id: "linked-source-pack" });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));

    const installRecords = {
      "linked-source-pack": {
        source: "path",
        installPath: pluginDir,
        sourcePath: pluginDir,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const result = discoverWithStateDir(stateDir, { installRecords });

    expectCandidateSource(
      result.candidates,
      "linked-source-pack",
      fs.realpathSync(path.join(pluginDir, "src", "index.ts")),
    );
    expectCandidateFields(requireCandidateById(result.candidates, "linked-source-pack"), {
      setupSource: fs.realpathSync(path.join(pluginDir, "src", "setup-entry.ts")),
      installOwner: "linked-source-pack",
    });
    expectNoDiagnostic({
      diagnostics: result.diagnostics,
      pluginId: "linked-source-pack",
      messageIncludes: "requires compiled runtime output",
    });
  });

  it.runIf(process.platform !== "win32" && canCreateDirectorySymlinks)(
    "still scans sibling package entries beside a duplicate installed file alias",
    () => {
      const stateDir = makeTempDir();
      const firstDir = path.join(stateDir, "extensions", "first");
      const secondDir = path.join(stateDir, "extensions", "second");
      const installedFile = path.join(firstDir, "index.js");
      const aliasedFile = path.join(secondDir, "alias.js");

      writePluginEntry(installedFile);
      createPackagePluginWithEntry(secondDir, "second", "second", "other.js");
      fs.symlinkSync(installedFile, aliasedFile);
      const result = discoverOpenClawPlugins({
        env: buildDiscoveryEnv(stateDir),
        installRecords: {
          first: { source: "npm", installPath: installedFile },
          alias: { source: "npm", installPath: aliasedFile },
        },
      });
      expect(result.candidates.map((candidate) => candidate.idHint)).toEqual(["index", "second"]);
      expect(isPluginCandidateInstallOwnerAmbiguous(result.candidates[0]!)).toBe(true);
      expectDiagnostic({
        diagnostics: result.diagnostics,
        messageIncludes: "multiple plugin install records claim the same package path",
      });
    },
  );

  it.runIf(canCreateDirectorySymlinks).each([
    { name: "official registry", overrides: {}, ambiguous: false, trusted: true },
    {
      name: "local archive",
      overrides: {
        sourcePath: "/tmp/diffs.tgz",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
      },
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
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "diffs");
    const aliasDir = path.join(stateDir, "diffs-link");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/diffs",
      extensions: ["./two.js", "./one.js"],
    });
    writePluginManifest({ pluginDir, id: "diffs" });
    for (const entry of ["two.js", "one.js"]) {
      fs.writeFileSync(
        path.join(pluginDir, entry),
        'throw new Error("must not evaluate metadata")',
      );
    }
    symlinkDirectory(pluginDir, aliasDir);
    const env = buildDiscoveryEnv(stateDir);
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
    expect(
      result.candidates.map((candidate) => ({
        id: candidate.idHint,
        source: candidate.source,
        origin: candidate.origin,
        owner: resolvePluginCandidateInstallOwner(candidate),
        ambiguous: isPluginCandidateInstallOwnerAmbiguous(candidate),
      })),
    ).toEqual(
      ["two", "one"].map((entry) => ({
        id: `diffs/${entry}`,
        source: fs.realpathSync(path.join(pluginDir, `${entry}.js`)),
        origin: "config",
        owner: scenario.ambiguous ? undefined : "diffs",
        ambiguous: scenario.ambiguous,
      })),
    );
    const registry = loadPluginManifestRegistryCore({ discovery: result, installRecords, env });
    expect(
      registry.plugins.map((plugin) => ({
        id: plugin.id,
        owner: resolvePluginManifestInstallOwner(plugin),
        trusted: plugin.trustedOfficialInstall,
      })),
    ).toEqual(
      ["two", "one"].map((entry) => ({
        id: `diffs/${entry}`,
        owner: scenario.ambiguous ? undefined : "diffs",
        trusted: scenario.trusted,
      })),
    );
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
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "plugin");
      const aliasDir = path.join(stateDir, "alias");

      writePluginManifest({ pluginDir, id: "plugin", requiresPlugins: ["missing"] });
      writePluginEntry(path.join(pluginDir, "index.js"));
      symlinkDirectory(pluginDir, aliasDir);
      const missing = path.join(stateDir, "missing.js");
      const loadPaths = [
        path.join(aliasDir, "index.js"),
        path.join(pluginDir, "index.js"),
        missing,
        missing,
      ];
      const env = buildDiscoveryEnv(stateDir);
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
        const stateDir = makeTempDir();
        const globalExt = path.join(stateDir, "extensions");
        const sourcePath = path.join(globalExt, "source-path-pack");
        const actualSource = linked ? path.join(stateDir, "checkout") : sourcePath;
        const installPath = path.join(stateDir, "installed", "source-path-pack");
        writePluginPackageManifest({
          packageDir: actualSource,
          packageName: "@openclaw/source-path-pack",
          extensions: ["./src/index.ts"],
        });
        writePluginEntry(path.join(actualSource, "src/index.ts"));
        if (linked) {
          mkdirSafe(globalExt);
          mkdirSafe(installPath);
          symlinkDirectory(actualSource, sourcePath);
        }
        const result = discoverWithStateDir(stateDir, {
          installRecords: { "source-path-pack": { source: "path", installPath, sourcePath } },
        });
        expectCandidateIds(result.candidates, { excludes: ["source-path-pack"] });
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            level: "warn",
            pluginId: "source-path-pack",
            source: sourcePath,
            message: expect.stringContaining("requires compiled runtime output"),
          }),
        ]);
      },
    );
  }

  it("adds managed ownership to bundled candidates deduplicated in the shared scan", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const plainDir = path.join(bundledDir, "plain");
    const packageDir = path.join(bundledDir, "package");

    writePluginManifest({ pluginDir: plainDir, id: "plain" });
    writePluginEntry(path.join(plainDir, "index.js"));
    writePluginPackageManifest({
      packageDir,
      packageName: "@openclaw/package",
      extensions: ["./index.js"],
    });
    writePluginManifest({ pluginDir: packageDir, id: "package" });
    writePluginEntry(path.join(packageDir, "index.js"));
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const installRecords = {
      "plain-owner": { source: "path", installPath: plainDir },
      "package-owner": { source: "path", installPath: packageDir },
    } satisfies Record<string, PluginInstallRecord>;

    const result = discoverOpenClawPlugins({ env, installRecords });

    expectCandidateSource(result.candidates, "plain", path.join(plainDir, "index.js"));
    expectCandidateFields(requireCandidateById(result.candidates, "plain"), {
      origin: "bundled",
      packageName: undefined,
      installOwner: "plain-owner",
    });
    expectCandidateSource(result.candidates, "package", path.join(packageDir, "index.js"));
    expectCandidateFields(requireCandidateById(result.candidates, "package"), {
      origin: "bundled",
      packageName: "@openclaw/package",
      installOwner: "package-owner",
    });

    const ambiguous = discoverOpenClawPlugins({
      env,
      installRecords: {
        ...installRecords,
        "other-owner": installRecords["plain-owner"],
      },
    });

    expectCandidateFields(requireCandidateById(ambiguous.candidates, "plain"), {
      origin: "bundled",
      installOwner: undefined,
      installOwnerAmbiguous: true,
    });
    expectDiagnostic({
      diagnostics: ambiguous.diagnostics,
      level: "error",
      messageIncludes: "multiple plugin install records claim the same package path",
    });
  });

  it("uses explicit runtime extension entries for installed package plugins", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-pack");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-pack",
      extensions: ["./src/index.ts"],
      runtimeExtensions: ["./dist/index.js"],
      setupEntry: "./src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));
    writePluginEntry(path.join(pluginDir, "dist", "setup-entry.js"));

    const { candidates } = discoverWithStateDir(stateDir, {});
    const candidate = findCandidateById(candidates, "runtime-pack");
    expect(fs.realpathSync(candidate?.source ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "index.js")),
    );
    expect(fs.realpathSync(candidate?.setupSource ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "setup-entry.js")),
    );
  });

  it("rejects missing explicit runtime setup entries for installed package plugins", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "missing-runtime-setup-pack");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/missing-runtime-setup-pack",
      extensions: ["./dist/index.js"],
      setupEntry: "./src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));

    const result = discoverWithStateDir(stateDir, {});
    const candidate = requireCandidateById(result.candidates, "missing-runtime-setup-pack");

    expect(candidate.setupSource).toBeUndefined();
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "missing-runtime-setup-pack" &&
          entry.message.includes("runtime setup entry not found") &&
          entry.message.includes("./dist/setup-entry.js"),
      ),
    ).toBe(true);
  });

  it.each([
    { pluginMetadataId: "plugin-owner", channelMetadataId: "channel-owner", owner: "plugin-owner" },
    { pluginMetadataId: 42, channelMetadataId: "channel-owner", owner: "channel-owner" },
    { pluginMetadataId: { invalid: true }, channelMetadataId: false, owner: undefined },
  ])(
    "normalizes setup owner metadata for callers without a prepared owner: %j",
    ({ pluginMetadataId, channelMetadataId, owner }) => {
      const pluginDir = makeTempDir();
      const diagnostics: ReturnType<typeof discoverOpenClawPlugins>["diagnostics"] = [];
      const manifest = structuredClone({
        openclaw: {
          setupEntry: "./missing-setup.js",
          plugin: { id: pluginMetadataId },
          channel: { id: channelMetadataId },
        },
      });

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

  it("rejects package runtimeExtensions that do not match extension entries", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-mismatch-pack");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-mismatch-pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
      runtimeExtensions: ["./dist/one.js"],
    });
    writePluginEntry(path.join(pluginDir, "src", "one.ts"));
    writePluginEntry(path.join(pluginDir, "src", "two.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "one.js"));

    const result = discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { absent: ["runtime-mismatch-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("runtimeExtensions length (1)") &&
          entry.message.includes("extensions length (2)"),
      ),
    ).toBe(true);
  });

  it("rejects blank package runtimeExtensions before falling back to inferred entries", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-blank-pack");

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-blank-pack",
      extensions: ["./src/index.ts"],
      runtimeExtensions: [" "],
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));

    const result = discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { absent: ["runtime-blank-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("openclaw.runtimeExtensions[0]") &&
          entry.message.includes("non-empty string"),
      ),
    ).toBe(true);
  });

  it("preserves explicit package plugin owners when their manifests are malformed", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "metadata-owner-root");

    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/package-name-owner",
      openclaw: { extensions: ["./index.js"], plugin: { id: "metadata-plugin-owner" } },
    });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
    writePluginEntry(path.join(pluginDir, "index.js"));

    const discovery = discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

    expect(discovery.candidates).toEqual([
      expect.objectContaining({ idHint: "metadata-plugin-owner" }),
    ]);
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "metadata-plugin-owner" }),
    ]);
  });

  it("keeps channel diagnostic ownership separate from a malformed package identity", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "channel-package-root");

    writeJson(path.join(pluginDir, "package.json"), {
      name: "@scope/",
      openclaw: { extensions: ["./index.js"], channel: { id: "channel-diagnostic-owner" } },
    });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
    writePluginEntry(path.join(pluginDir, "index.js"));

    const discovery = discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

    expect(discovery.candidates).toEqual([
      expect.objectContaining({
        idHint: "channel-package-root",
        diagnosticIdHint: "channel-diagnostic-owner",
      }),
    ]);
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "channel-diagnostic-owner" }),
    ]);
  });

  it("retains every owner when invalid package extension diagnostics are deduplicated", () => {
    const stateDir = makeTempDir();
    for (const [packageName, pluginId, explicitOwner] of [
      [undefined, "first-blank-pack", undefined],
      [42, "second-blank-pack", undefined],
      ["@openclaw/example-plugin", "example", undefined],
      ["@openclaw/manifest-derived-package", "manifest-owner", "manifest"],
      ["@openclaw/channel-derived-package", "channel-owner", "channel"],
    ] as const) {
      const pluginDir = path.join(stateDir, "extensions", pluginId);

      writeJson(path.join(pluginDir, "package.json"), {
        name: packageName,
        openclaw: {
          extensions: ["./dist/index.js", " "],
          ...(explicitOwner === "channel" ? { channel: { id: pluginId } } : {}),
        },
      });
      writePluginEntry(path.join(pluginDir, "dist", "index.js"));
      if (explicitOwner === "manifest") {
        writePluginManifest({ pluginDir, id: pluginId });
      }
    }

    const discovery = discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });
    const errors = registry.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("openclaw.extensions[1]"),
    );

    expect(errors).toHaveLength(5);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", pluginId: "first-blank-pack" }),
        expect.objectContaining({ level: "error", pluginId: "second-blank-pack" }),
        expect.objectContaining({ level: "error", pluginId: "example" }),
        expect.objectContaining({ level: "error", pluginId: "manifest-owner" }),
        expect.objectContaining({ level: "error", pluginId: "channel-owner" }),
      ]),
    );
  });

  it.each([
    {
      name: "manifest owner wins for incompatible API ranges",
      packageName: "@openclaw/package-owner",
      manifestId: "manifest-owner",
      packagePluginId: "package-plugin-owner",
      packageChannelId: "package-channel-owner",
      pluginApi: ">=2026.5.27-beta.2",
      expectedOwner: "manifest-owner",
    },
    {
      name: "channel owner wins for malformed API ranges",
      packageName: "@openclaw/package-owner",
      manifestId: undefined,
      packagePluginId: 42,
      packageChannelId: "package-channel-owner",
      pluginApi: 20260527,
      expectedOwner: "package-channel-owner",
    },
    {
      name: "directory owner handles malformed package and metadata identities",
      packageName: false,
      manifestId: undefined,
      packagePluginId: { invalid: true },
      packageChannelId: ["invalid"],
      pluginApi: 20260527,
      expectedOwner: "compatibility-owner",
    },
  ])(
    "attributes incompatible package API diagnostics to the canonical owner: $name",
    ({ packageName, manifestId, packagePluginId, packageChannelId, pluginApi, expectedOwner }) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "compatibility-owner");

      writeJson(path.join(pluginDir, "package.json"), {
        name: packageName,
        openclaw: {
          extensions: [" "],
          plugin: { id: packagePluginId },
          channel: { id: packageChannelId },
          compat: { pluginApi },
        },
      });
      if (manifestId) {
        writePluginManifest({ pluginDir, id: manifestId });
      }

      const result = discoverOpenClawPlugins({
        env: buildDiscoveryEnvWithOverrides(stateDir, {
          OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
        }),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: "warn", pluginId: expectedOwner }),
      );
      expectNoDiagnostic({
        diagnostics: result.diagnostics,
        messageIncludes: "openclaw.extensions",
      });
    },
  );

  it("keeps trusted bundled package fallback from missing TypeScript metadata to JavaScript", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "downloadable");

    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/downloadable",
      openclaw: {
        extensions: ["./index.ts"],
        compat: { pluginApi: ">=2099.1.1" },
      },
    });
    writePluginManifest({ pluginDir, id: "downloadable" });
    writePluginEntry(path.join(pluginDir, "index.js"));

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
    });

    expectCandidateSource(
      candidates,
      "downloadable",
      fs.realpathSync(path.join(pluginDir, "index.js")),
    );
    expect(diagnostics).toStrictEqual([]);
  });

  it("discovers source-checkout-only bundled plugins alongside built bundled plugins", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "openclaw");
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
      createPackagePluginWithEntry(root, `@openclaw/${id}`, id, entry);
    }

    const { candidates } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
    });

    expectCandidateIds(candidates, { includes: ["shipped", "downloadable"] });
    expect(fs.realpathSync(findCandidateById(candidates, "shipped")?.source ?? "")).toBe(
      fs.realpathSync(path.join(builtPluginDir, "index.js")),
    );
    expect(fs.realpathSync(findCandidateById(candidates, "downloadable")?.source ?? "")).toBe(
      fs.realpathSync(path.join(sourceOnlyPluginDir, "index.ts")),
    );
  });

  it.each([
    {
      format: "agent",
      id: "portable-bundle",
      marker: "plugin.json",
      directory: "skills/sample",
      manifest: {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "portable-bundle",
      },
    },
    {
      format: "claude",
      id: "claude-bundle",
      marker: "settings.json",
      directory: "commands",
      manifest: { hideThinkingBlock: true },
    },
    {
      format: "cursor",
      id: "cursor-bundle",
      marker: ".cursor-plugin/plugin.json",
      directory: ".cursor/commands",
      manifest: { name: "Cursor Bundle" },
    },
  ])(
    "discovers $format bundles from their metadata and default layout",
    ({ format, id, marker, directory, manifest }) => {
      const stateDir = makeTempDir();
      const bundleDir = path.join(stateDir, "extensions", id);
      writeJson(path.join(bundleDir, marker), manifest);
      mkdirSafe(path.join(bundleDir, directory));
      const bundle = requireCandidateById(discoverWithStateDir(stateDir).candidates, id);
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
    const stateDir = makeTempDir();
    const bundleDir = path.join(stateDir, "extensions", "package-owner");
    writeJson(path.join(bundleDir, ".codex-plugin/plugin.json"), {
      name: "runtime-child",
      skills: "skills",
    });
    mkdirSafe(path.join(bundleDir, "skills"));

    const { candidates } = discoverWithStateDir(stateDir, {
      installRecords: {
        "package-owner": {
          source: "path",
          sourcePath: bundleDir,
          installPath: bundleDir,
        },
      },
    });

    expectCandidateFields(requireCandidateById(candidates, "runtime-child"), {
      installOwner: "package-owner",
    });
  });

  it("falls back to the native index when a configured bundle sidecar is malformed", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "legacy-with-bad-bundle");
    const marker = path.join(pluginDir, ".codex-plugin", "plugin.json");
    writePluginEntry(path.join(pluginDir, "index.ts"));
    writePluginEntry(marker, "{");
    const result = discoverWithStateDir(stateDir, { extraPaths: [pluginDir] });
    expect(findCandidateById(result.candidates, "legacy-with-bad-bundle")?.format).toBe("openclaw");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ source: marker }));
  });

  type EscapeFixture = {
    name: string;
    entry: string;
    files: string[];
    runtime?: string;
    symlink?: [string, string];
    hardlink?: [string, string];
  };
  it.each([
    {
      name: "blocks extension entries that escape package directory",
      entry: "../../outside.js",
      files: ["../../outside.js"],
    },
    {
      name: "blocks escaping source entries before explicit runtime entries",
      entry: "../src/index.ts",
      runtime: "./dist/index.js",
      files: ["dist/index.js"],
    },
    {
      name: "rejects package extension entries that escape via symlink",
      entry: "./linked/escape.ts",
      files: ["../../outside/escape.ts"],
      symlink: ["../../outside", "linked"],
    },
    {
      name: "rejects hardlinked TypeScript entries before built runtime inference",
      entry: "./escape.ts",
      files: ["../../outside/escape.ts", "dist/escape.js"],
      hardlink: ["../../outside/escape.ts", "escape.ts"],
    },
    {
      name: "rejects hardlinked inferred built runtime entries instead of falling back to source",
      entry: "./src/index.ts",
      files: ["src/index.ts", "../../outside/index.js"],
      hardlink: ["../../outside/index.js", "dist/index.js"],
    },
  ] satisfies EscapeFixture[])("$name", (scenario: EscapeFixture) => {
    if (scenario.hardlink && process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "pack");
    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/pack",
      extensions: [scenario.entry],
      ...(scenario.runtime ? { runtimeExtensions: [scenario.runtime] } : {}),
    });
    for (const file of scenario.files) {
      writePluginEntry(path.join(pluginDir, file));
    }
    if (scenario.symlink) {
      try {
        symlinkDirectory(
          path.join(pluginDir, scenario.symlink[0]),
          path.join(pluginDir, scenario.symlink[1]),
        );
      } catch {
        return;
      }
    }
    if (scenario.hardlink) {
      const target = path.join(pluginDir, scenario.hardlink[1]);
      mkdirSafe(path.dirname(target));
      try {
        fs.linkSync(path.join(pluginDir, scenario.hardlink[0]), target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EXDEV") {
          return;
        }
        throw error;
      }
    }
    const result = discoverWithStateDir(stateDir);
    expect(result.candidates).toEqual([]);
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("blocks escaping setup entries before explicit runtime setup entries", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "escape-pack");

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/escape-pack",
      extensions: ["./dist/index.js"],
      setupEntry: "../src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    writePluginEntry(path.join(globalExt, "dist", "index.js"), "export default {}");
    writePluginEntry(path.join(globalExt, "dist", "setup-entry.js"), "export default {}");

    const result = discoverWithStateDir(stateDir, {});
    const candidate = requireCandidateById(result.candidates, "escape-pack");

    expect(candidate.setupSource).toBeUndefined();
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("ignores package manifests that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideManifest = path.join(outsideDir, "package.json");
    const linkedManifest = path.join(globalExt, "package.json");
    mkdirSafe(globalExt);

    writePluginEntry(path.join(globalExt, "entry.ts"), "export default {}");
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

    const { candidates } = discoverWithStateDir(stateDir, {});

    expect(candidates.map((candidate) => candidate.idHint)).not.toContain("pack");
  });

  it.runIf(process.platform !== "win32").each(["configured", "automatic"] as const)(
    "repairs a world-writable bundled plugin without blocked warnings via %s discovery",
    (selection) => {
      const stateDir = makeTempDir();
      const packageRoot = path.join(stateDir, "node_modules", "openclaw");
      const bundledDir = path.join(packageRoot, "dist", "extensions");
      const pluginDir = path.join(bundledDir, "repairable");
      createPackagePluginWithEntry(pluginDir, "repairable", undefined, "index.js");
      fs.chmodSync(pluginDir, 0o777);
      const result = withOpenClawPackageArgv(packageRoot, () =>
        discoverOpenClawPlugins({
          env: buildDiscoveryEnvWithOverrides(stateDir, {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: selection === "configured" ? bundledDir : undefined,
          }),
          extraPaths: selection === "configured" ? [pluginDir, pluginDir] : [],
        }),
      );
      expect(result.candidates).toHaveLength(1);
      expectCandidateFields(result.candidates[0]!, { idHint: "repairable", origin: "bundled" });
      expect(result.diagnostics).toEqual([]);
      expect(fs.statSync(pluginDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(canCreateDirectorySymlinks)(
    "does not grant bundled provenance to an outside package symlink",
    () => {
      const stateDir = makeTempDir();
      const bundledDir = path.join(stateDir, "bundled");
      const outsideDir = path.join(stateDir, "outside");
      mkdirSafe(bundledDir);
      createPackagePluginWithEntry(outsideDir, "@openclaw/codex", "codex", "index.js");
      symlinkDirectory(outsideDir, path.join(bundledDir, "codex"));
      for (const extraPaths of [[], [outsideDir]]) {
        const result = discoverOpenClawPlugins({
          env: buildDiscoveryEnvWithOverrides(stateDir, {
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          }),
          extraPaths,
        });
        expect(result.candidates).toHaveLength(extraPaths.length);
        expect(result.candidates.every((candidate) => candidate.origin === "config")).toBe(true);
        expectDiagnostic({
          diagnostics: result.diagnostics,
          messageIncludes: "escapes bundled root",
        });
      }
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "blocks suspicious ownership when uid mismatch is detected",
    () => {
      const stateDir = makeTempDir();
      createPackagePluginWithEntry(
        path.join(stateDir, "extensions", "owner-mismatch"),
        "@openclaw/owner-mismatch",
        "owner-mismatch",
      );

      const actualUid = (process as NodeJS.Process & { getuid: () => number }).getuid();
      const result = discoverWithStateDir(stateDir, { ownershipUid: actualUid + 1 });
      const shouldBlockForMismatch = actualUid !== 0;
      expect(result.candidates).toHaveLength(shouldBlockForMismatch ? 0 : 1);
      const hasSuspiciousOwnershipDiagnostic = result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("suspicious ownership"),
      );
      expect(hasSuspiciousOwnershipDiagnostic).toBe(shouldBlockForMismatch);
      if (shouldBlockForMismatch) {
        expectDiagnostic({
          diagnostics: result.diagnostics,
          pluginId: "owner-mismatch",
          messageIncludes: "suspicious ownership",
        });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses native manifest ids for blocked index-file directory diagnostics",
    () => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "alias-dir");

      writePluginManifest({ pluginDir, id: "actual-id" });
      writePluginEntry(path.join(pluginDir, "index.ts"));
      fs.chmodSync(pluginDir, 0o777);

      try {
        const result = discoverWithStateDir(stateDir, { extraPaths: [pluginDir] });
        expect(result.candidates).toHaveLength(0);
        expectDiagnostic({
          diagnostics: result.diagnostics,
          pluginId: "actual-id",
          source: pluginDir,
          messageIncludes: "blocked plugin candidate: world-writable path",
        });
      } finally {
        fs.chmodSync(pluginDir, 0o755);
      }
    },
  );

  it("refreshes same-size bundled package manifests when plugin metadata is reloaded", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "cached-bundle");
    createPackagePluginWithEntry(pluginDir, "@openclaw/cache-one", "cached-bundle", "index.js");
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const packageManifestPath = path.join(pluginDir, "package.json");
    const unchangedTimestamp = new Date("2025-01-01T00:00:00.000Z");
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);

    const workspaceA = path.join(stateDir, "workspace-a");
    const workspaceB = path.join(stateDir, "workspace-b");
    const first = discoverOpenClawPlugins({ env, workspaceDir: workspaceA });
    expect(requireCandidateById(first.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-one",
    );
    const originalStat = fs.statSync(packageManifestPath);
    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/cache-two",
      extensions: ["./index.js"],
    });
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);
    const replacementStat = fs.statSync(packageManifestPath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

    const beforeReload = discoverOpenClawPlugins({ env, workspaceDir: workspaceB });
    expect(requireCandidateById(beforeReload.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-one",
    );

    clearPluginMetadataLifecycleCaches();

    const afterReload = discoverOpenClawPlugins({ env, workspaceDir: workspaceB });
    expect(requireCandidateById(afterReload.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-two",
    );
  });

  it("keeps configured selection and installed ownership isolated across workspace scans", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const bundledPlugin = path.join(bundledDir, "shared-plugin");
    const installedPlugin = path.join(stateDir, "installed", "shared-plugin");
    for (const packageDir of [bundledPlugin, installedPlugin]) {
      createPackagePluginWithEntry(
        packageDir,
        "@openclaw/shared-plugin",
        "shared-plugin",
        "index.js",
      );
    }
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
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
        const winner = registry.plugins.find((plugin) => plugin.id === "shared-plugin");
        if (!winner) {
          throw new Error("Expected a selected shared-plugin manifest");
        }
        return { discovery, winner };
      };
      const initial = read();
      expect(initial.winner.rootDir).toBe(fs.realpathSync(installedPlugin));
      const workspaceA = path.join(stateDir, "workspace-a");
      const selected = read(workspaceA, [bundledPlugin]);
      expect(selected.winner.rootDir).toBe(fs.realpathSync(bundledPlugin));
      expect(selected.winner.sourcePreferred).toBe(true);
      const workspaceB = path.join(stateDir, "workspace-b");
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
        expectCandidateFields(installed, { workspaceDir, installOwner: "installed-owner" });
      }
      expect(selected.winner.sourcePreferred).toBe(true);
      expect(ordinary.winner.sourcePreferred).toBeUndefined();
    });
  });

  it("discovers bundled and global plugins for each workspace-specific scan", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const globalExt = path.join(stateDir, "extensions");
    const workspaceA = path.join(stateDir, "workspace-a");
    const workspaceB = path.join(stateDir, "workspace-b");

    for (const [root, id] of [
      [bundledDir, "bundled-plugin"],
      [globalExt, "global-plugin"],
      [path.join(workspaceA, ".openclaw", "extensions"), "workspace-a-plugin"],
      [path.join(workspaceB, ".openclaw", "extensions"), "workspace-b-plugin"],
    ] as const) {
      createPackagePluginWithEntry(path.join(root, id), `@openclaw/${id}`, id);
    }

    const env = {
      ...buildDiscoveryEnv(stateDir),
      HOME: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    };
    const first = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ workspaceDir: "~/workspace-a", env }),
    );
    expectCandidatePresence(first, {
      present: ["bundled-plugin", "global-plugin", "workspace-a-plugin"],
      absent: ["workspace-b-plugin"],
    });

    const second = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ workspaceDir: workspaceB, env }),
    );
    expectCandidatePresence(second, {
      present: ["bundled-plugin", "global-plugin", "workspace-b-plugin"],
      absent: ["workspace-a-plugin"],
    });

    const bundledOnly = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({
        workspaceDir: workspaceA,
        extraPaths: [path.join(stateDir, "missing-configured-plugin")],
        installRecords: { missing: { source: "npm", installPath: stateDir } },
        rootScope: "bundled",
        env,
      }),
    );
    expect(bundledOnly.candidates.map((candidate) => candidate.idHint)).toEqual(["bundled-plugin"]);
    expect(bundledOnly.diagnostics).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
