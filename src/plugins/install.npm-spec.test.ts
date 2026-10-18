// Covers npm spec parsing for plugin install inputs.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import {
  mockNpmViewMetadataResult,
  npmCommandFailureCases,
} from "../test-utils/npm-spec-install-test-helpers.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentRequest } from "./install-types.js";
import {
  prunePluginLocalOpenClawPeerLinks,
  readTextFileTree,
  registerManagedNpmDependencyTests,
} from "./install.npm-dependencies.test-support.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "./managed-npm-retention.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";
import { registerNpmUpdateMetadataTests } from "./update-npm-metadata.test-support.js";

const runCommandMock = vi.fn();
const resolveOpenClawPackageRootSyncMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandMock(...args),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (...args: unknown[]) =>
    resolveOpenClawPackageRootSyncMock(...args),
}));

vi.resetModules();

const {
  installPluginFromNpmPackArchive: installPack,
  installPluginFromNpmSpec: installSpec,
  PLUGIN_INSTALL_ERROR_CODE,
} = await import("./install.js");

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-npm-spec");
const makeTempDir = () => suiteTempRootTracker.makeTempDir();
let previousNpmGlobalConfig: string | undefined;
let npmGlobalConfigPath: string;
let npmRoot: string;
const silentLogger = { info: () => {}, warn: () => {} };
function installNpm(params: Parameters<typeof installSpec>[0]) {
  return installSpec({ npmDir: npmRoot, logger: silentLogger, ...params });
}

function installPackArchive(params: Parameters<typeof installPack>[0]) {
  return installPack({ npmDir: npmRoot, logger: silentLogger, ...params });
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

type TestManifest = {
  version?: string;
  dependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  openclaw?: { managedPeerDependencies?: string[]; managedOverrides?: string[] };
};
type TestLockfile = {
  packages?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
};
function readManifest(root: string): TestManifest {
  return JSON.parse(readText(root, "package.json"));
}
function readLockfile(root: string): TestLockfile {
  return JSON.parse(readText(root, "package-lock.json"));
}
function readText(...parts: string[]) {
  return fs.readFileSync(path.join(...parts), "utf8");
}
function expectAbsent(...paths: string[]) {
  for (const filePath of paths) {
    expect(fs.existsSync(filePath)).toBe(false);
  }
}
function npmDelegate() {
  const delegate = runCommandMock.getMockImplementation();
  if (!delegate) {
    throw new Error("expected npm mock implementation");
  }
  return delegate;
}

function successfulSpawn(stdout = "") {
  return {
    code: 0,
    stdout,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

function failedSpawn(stderr: string, stdout = "") {
  return { ...successfulSpawn(stdout), code: 1, stderr };
}

function npmViewArgs(spec: string): string[] {
  return ["view", spec, "name", "version", "dist.integrity", "dist.shasum", "openclaw", "--json"];
}

function npmViewVersionsArgs(spec: string): string[] {
  return ["view", spec, "versions", "--json"];
}

function npmPackArchiveMetadataArgs(archivePath: string): string[] {
  return ["pack", archivePath, "--ignore-scripts", "--dry-run", "--json"];
}

function commandKey(argv: readonly string[]): string {
  return argv.join("\0");
}

function resolveManagedFileDependency(projectRoot: string, dependencySpec: string): string | null {
  if (!dependencySpec.startsWith("file:")) {
    return null;
  }
  const rawPath = dependencySpec.slice("file:".length);
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
}

function isNpmInstallCommand(argv: unknown): argv is string[] {
  return Array.isArray(argv) && npmCommandArgs(argv)?.[0] === "install";
}

function isNpmPeerPlannerInstallCommand(argv: unknown): argv is string[] {
  return isNpmInstallCommand(argv) && argv.includes("--package-lock-only");
}

function isManagedNpmInstallCommand(argv: unknown): argv is string[] {
  return isNpmInstallCommand(argv) && !isNpmPeerPlannerInstallCommand(argv);
}

function managedNpmRootHasDependency(projectRoot: string, packageName: string): boolean {
  const manifest = readManifest(projectRoot);
  return packageName in (manifest.dependencies ?? {});
}

function expectManagedNpmQuarantine(diagnostics: string[]): string {
  const installCall = runCommandMock.mock.calls.find(([argv]) => isManagedNpmInstallCommand(argv));
  const stageRoot = installCall?.[1]?.cwd;
  if (typeof stageRoot !== "string") {
    throw new Error("expected managed npm execution root");
  }
  expectAbsent(stageRoot);
  const quarantineParent = path.join(path.dirname(stageRoot), "_openclaw-quarantined-npm-projects");
  const quarantines = fs.readdirSync(quarantineParent);
  expect(quarantines).toHaveLength(1);
  const quarantineDir = path.join(quarantineParent, quarantines[0]!);
  expect(fs.statSync(quarantineDir).isDirectory()).toBe(true);
  expect(diagnostics.some((message) => message.includes(quarantineDir))).toBe(true);
  return quarantineDir;
}

function installedPackageDir(projectRoot: string, packageName: string): string {
  return path.join(
    resolvePluginNpmProjectDir({
      npmDir: projectRoot,
      packageName,
    }),
    "node_modules",
    ...packageName.split("/"),
  );
}

type Generation = {
  npmRoot: string;
  packageName: string;
  version: string;
  integrity?: string;
  shasum?: string;
};
function resolveTestPluginGenerationProjectDir(params: Generation): string {
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmRoot,
    packageName: params.packageName,
    generationKey: [
      params.packageName,
      params.version,
      `${params.packageName}@${params.version}`,
      params.integrity ?? "sha512-plugin-test",
      params.shasum ?? "pluginshasum",
    ].join("\n"),
  });
}

function resolveTestPluginGenerationPackageDir(params: Generation): string {
  return path.join(
    resolveTestPluginGenerationProjectDir(params),
    "node_modules",
    ...params.packageName.split("/"),
  );
}

function writeInstalledNpmPlugin(params: MockNpmPackage) {
  const pluginDir = path.join(params.npmRoot, "node_modules", params.packageName);
  if (params.replaceExisting) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  writeJson(path.join(pluginDir, "package.json"), {
    name: params.packageName,
    version: params.version,
    openclaw: params.openclaw ?? { extensions: ["./dist/index.js"] },
    ...(params.dependency
      ? { dependencies: { [params.dependency.name]: params.dependency.version } }
      : {}),
    ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
  });
  if (params.nativeManifest !== "missing") {
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      params.nativeManifest === "malformed"
        ? "{invalid plugin manifest"
        : JSON.stringify({
            id: params.pluginId ?? params.packageName,
            name: params.pluginId ?? params.packageName,
            ...(params.legacyPluginIds ? { legacyPluginIds: params.legacyPluginIds } : {}),
            configSchema: { type: "object" },
          }),
      "utf-8",
    );
  }
  fs.writeFileSync(
    path.join(pluginDir, "dist", "index.js"),
    params.indexJs ?? "export {};",
    "utf-8",
  );
  for (const [relativePath, contents] of Object.entries(params.extraDistFiles ?? {})) {
    const targetPath = path.join(pluginDir, "dist", relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, "utf-8");
  }
  if (params.dependency) {
    writeDependency(pluginDir, params.dependency);
  }
  if (params.hoistedDependency) {
    writeDependency(params.npmRoot, params.hoistedDependency);
  }
  return pluginDir;
}

function writeDependency(root: string, dependency: { name: string; version: string }) {
  const depDir = path.join(root, "node_modules", dependency.name);
  fs.mkdirSync(depDir, { recursive: true });
  writeJson(path.join(depDir, "package.json"), dependency);
}

type MockNpmPackage = {
  spec?: string;
  packageName: string;
  version: string;
  npmRoot: string;
  pluginId?: string;
  nativeManifest?: "missing" | "malformed";
  legacyPluginIds?: string[];
  integrity?: string;
  shasum?: string;
  indexJs?: string;
  extraDistFiles?: Record<string, string>;
  dependency?: { name: string; version: string };
  hoistedDependency?: { name: string; version: string };
  peerDependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  expectedDependencySpec?: string;
  versions?: string[];
  installedVersion?: string;
  installedIntegrity?: string;
  omitViewIntegrity?: boolean;
  omitInstalledVersion?: boolean;
  omitInstalledIntegrity?: boolean;
  materializesRootOpenClaw?: boolean;
  skipLockfileEntry?: boolean;
  packArchivePath?: string;
  packTarballName?: string;
  replaceExisting?: boolean;
};

function writeNpmRootPackageLock(params: {
  npmRoot: string;
  dependencies: Record<string, string>;
  packages: MockNpmPackage[];
}) {
  const lockPackages: Record<string, unknown> = {
    "": {
      dependencies: params.dependencies,
    },
  };
  for (const pkg of params.packages) {
    if (pkg.skipLockfileEntry) {
      continue;
    }
    lockPackages[`node_modules/${pkg.packageName}`] = {
      ...(pkg.omitInstalledVersion ? {} : { version: pkg.installedVersion ?? pkg.version }),
      ...(pkg.omitInstalledIntegrity
        ? {}
        : { integrity: pkg.installedIntegrity ?? pkg.integrity ?? "sha512-plugin-test" }),
    };
    if (pkg.materializesRootOpenClaw) {
      lockPackages["node_modules/openclaw"] = {
        peer: true,
        version: "2026.5.3",
      };
    }
  }
  writeJson(path.join(params.npmRoot, "package-lock.json"), {
    lockfileVersion: 3,
    packages: lockPackages,
  });
}

function writeMissingCurrentPlatformOptionalPackage(params: {
  npmRoot: string;
  packageName: string;
  packageLocation: string;
}): void {
  const lockPath = path.join(params.npmRoot, "package-lock.json");
  const lockfile = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
    packages?: Record<string, unknown>;
  };
  lockfile.packages ??= {};
  lockfile.packages[params.packageLocation] = {
    name: params.packageName,
    version: "1.0.0-platform",
    optional: true,
    os: [process.platform],
    cpu: [process.arch],
  };
  writeJson(lockPath, lockfile);
  fs.rmSync(path.join(params.npmRoot, ...params.packageLocation.split("/")), {
    recursive: true,
    force: true,
  });
}

function mockPlatformPlugin() {
  const packageName = "@openclaw/codex-fixture";
  const platformPackage = "@vendor/codex-platform";
  const platformPackageLocation = path.posix.join(
    "node_modules",
    packageName,
    "node_modules",
    platformPackage,
  );
  mockPackage({
    spec: `${packageName}@1.0.0`,
    pluginId: "codex-fixture",
    expectedDependencySpec: "1.0.0",
    openclaw: {
      extensions: ["./dist/index.js"],
      install: { requiredPlatformPackages: [platformPackage] },
    },
  });
  return { packageName, platformPackage, platformPackageLocation };
}

function mockPackage(
  params: Omit<MockNpmPackage, "npmRoot" | "packageName" | "version"> & {
    spec: string;
    npmRoot?: string;
    packageName?: string;
    version?: string;
  },
) {
  const selector = params.spec.lastIndexOf("@");
  mockPackages([
    Object.assign(params, {
      npmRoot: params.npmRoot ?? npmRoot,
      packageName:
        params.packageName ?? (selector > 0 ? params.spec.slice(0, selector) : params.spec),
      version: params.version ?? "1.0.0",
    }),
  ]);
}

async function installFixture(
  spec: string,
  fixture: Omit<Parameters<typeof mockPackage>[0], "spec">,
  options: Omit<Parameters<typeof installNpm>[0], "spec"> = {},
) {
  mockPackage({ spec, ...fixture });
  return installNpm({ spec, ...options });
}

function mockPackages(packages: MockNpmPackage[]) {
  const packagesByName = new Map(packages.map((pkg) => [pkg.packageName, pkg]));
  const packPackagesByArgv = new Map(
    packages
      .filter((pkg) => pkg.packArchivePath)
      .map((pkg) => [commandKey(npmPackArchiveMetadataArgs(pkg.packArchivePath ?? "")), pkg]),
  );
  const viewPackagesByArgv = new Map(
    packages.filter((pkg) => pkg.spec).map((pkg) => [commandKey(npmViewArgs(pkg.spec ?? "")), pkg]),
  );
  const versionsPackagesByArgv = new Map(
    packages
      .filter((pkg) => pkg.versions)
      .map((pkg) => [commandKey(npmViewVersionsArgs(pkg.packageName)), pkg]),
  );
  runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
    const npmArgs = npmCommandArgs(argv);
    if (!npmArgs) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    const argvKey = commandKey(npmArgs);
    const packPackage = packPackagesByArgv.get(argvKey);
    if (packPackage) {
      return successfulSpawn(
        JSON.stringify([
          {
            id: `${packPackage.packageName}@${packPackage.version}`,
            name: packPackage.packageName,
            version: packPackage.version,
            filename:
              packPackage.packTarballName ??
              `${packPackage.packageName.replace(/^@/, "").replace("/", "-")}-${packPackage.version}.tgz`,
            integrity: packPackage.integrity ?? "sha512-plugin-test",
            shasum: packPackage.shasum ?? "pluginshasum",
          },
        ]),
      );
    }
    const viewPackage = viewPackagesByArgv.get(argvKey);
    if (viewPackage) {
      return successfulSpawn(
        JSON.stringify({
          name: viewPackage.packageName,
          version: viewPackage.version,
          dist: {
            ...(viewPackage.omitViewIntegrity
              ? {}
              : { integrity: viewPackage.integrity ?? "sha512-plugin-test" }),
            shasum: viewPackage.shasum ?? "pluginshasum",
          },
          ...(viewPackage.openclaw ? { openclaw: viewPackage.openclaw } : {}),
        }),
      );
    }
    const versionsPackage = versionsPackagesByArgv.get(argvKey);
    if (versionsPackage) {
      return successfulSpawn(JSON.stringify(versionsPackage.versions ?? [versionsPackage.version]));
    }
    if (isNpmPeerPlannerInstallCommand(argv)) {
      const projectRoot = options?.cwd;
      if (!projectRoot) {
        throw new Error(`unexpected npm peer planner command: ${argv.join(" ")}`);
      }
      const manifest = readManifest(projectRoot);
      writeNpmRootPackageLock({
        npmRoot: projectRoot,
        dependencies: manifest.dependencies ?? {},
        packages: Object.keys(manifest.dependencies ?? {})
          .map((packageName) => packagesByName.get(packageName))
          .filter((pkg): pkg is MockNpmPackage => Boolean(pkg)),
      });
      return successfulSpawn();
    }
    if (isManagedNpmInstallCommand(argv)) {
      const projectRoot = options?.cwd;
      if (!projectRoot) {
        throw new Error(`unexpected npm install command: ${(argv as string[]).join(" ")}`);
      }
      const manifest = readManifest(projectRoot);
      const installedPackages: MockNpmPackage[] = [];
      prunePluginLocalOpenClawPeerLinks(projectRoot);
      for (const packageName of Object.keys(manifest.dependencies ?? {})) {
        if (packageName === "openclaw") {
          const openclawRoot = path.join(projectRoot, "node_modules", "openclaw");
          fs.mkdirSync(openclawRoot, { recursive: true });
          writeJson(path.join(openclawRoot, "package.json"), {
            name: "openclaw",
            version: "0.0.0-test",
          });
          continue;
        }
        const pkg = packagesByName.get(packageName);
        if (!pkg) {
          throw new Error(`unexpected managed npm dependency: ${packageName}`);
        }
        const dependencySpec = manifest.dependencies?.[packageName];
        if (pkg.expectedDependencySpec && dependencySpec !== pkg.expectedDependencySpec) {
          throw new Error(
            `expected managed npm dependency ${packageName}@${pkg.expectedDependencySpec}, got ${dependencySpec ?? ""}`,
          );
        }
        const fileDependencyPath = dependencySpec
          ? resolveManagedFileDependency(projectRoot, dependencySpec)
          : null;
        if (fileDependencyPath && !fs.existsSync(fileDependencyPath)) {
          throw new Error(`missing managed npm file dependency: ${fileDependencyPath}`);
        }
        writeInstalledNpmPlugin({
          ...pkg,
          npmRoot: projectRoot,
          version: pkg.installedVersion ?? pkg.version,
        });
        if (pkg.materializesRootOpenClaw) {
          const openclawRoot = path.join(projectRoot, "node_modules", "openclaw");
          fs.mkdirSync(openclawRoot, { recursive: true });
          writeJson(path.join(openclawRoot, "package.json"), {
            name: "openclaw",
            version: "2026.5.3",
          });
        }
        installedPackages.push(pkg);
      }
      writeNpmRootPackageLock({
        npmRoot: projectRoot,
        dependencies: manifest.dependencies ?? {},
        packages: installedPackages,
      });
      return successfulSpawn();
    }
    if (npmArgs[0] === "uninstall") {
      const packageName = (argv as string[]).at(-1);
      if (packageName === "openclaw") {
        const projectRoot = options?.cwd;
        if (!projectRoot) {
          throw new Error(`unexpected npm uninstall command: ${(argv as string[]).join(" ")}`);
        }
        fs.rmSync(path.join(projectRoot, "node_modules", "openclaw"), {
          recursive: true,
          force: true,
        });
        return successfulSpawn();
      }
      const pkg = packageName ? packagesByName.get(packageName) : undefined;
      if (!pkg) {
        throw new Error(`unexpected npm uninstall package: ${packageName ?? ""}`);
      }
      fs.rmSync(
        path.join(options?.cwd ?? pkg.npmRoot, "node_modules", ...pkg.packageName.split("/")),
        {
          recursive: true,
          force: true,
        },
      );
      return successfulSpawn();
    }
    throw new Error(`unexpected command: ${(argv as string[]).join(" ")}`);
  });
}

beforeAll(() => {
  previousNpmGlobalConfig = process.env.NPM_CONFIG_GLOBALCONFIG;
  npmGlobalConfigPath = path.join(makeTempDir(), "global-npmrc");
  fs.writeFileSync(npmGlobalConfigPath, "", "utf8");
  process.env.NPM_CONFIG_GLOBALCONFIG = npmGlobalConfigPath;
});

afterAll(() => {
  if (previousNpmGlobalConfig === undefined) {
    delete process.env.NPM_CONFIG_GLOBALCONFIG;
  } else {
    process.env.NPM_CONFIG_GLOBALCONFIG = previousNpmGlobalConfig;
  }
  suiteTempRootTracker.cleanup();
});

beforeEach(() => {
  npmRoot = path.join(makeTempDir(), "npm");
  runCommandMock.mockReset();
  resolveOpenClawPackageRootSyncMock.mockReset();
  const hostRoot = makeTempDir();
  writeJson(path.join(hostRoot, "package.json"), { name: "openclaw", version: "0.0.0-test" });
  resolveOpenClawPackageRootSyncMock.mockReturnValue(hostRoot);
  vi.unstubAllEnvs();
  process.env.NPM_CONFIG_GLOBALCONFIG = npmGlobalConfigPath;
});

describe("installPluginFromNpmSpec", () => {
  registerNpmUpdateMetadataTests({
    getNpmRoot: () => npmRoot,
    installPluginFromNpmSpec: installNpm,
    isManagedNpmInstallCommand,
    mockNpmViewAndInstallMany: mockPackages,
    runCommandWithTimeoutMock: runCommandMock,
    writeInstalledNpmPlugin,
  });

  it.each(npmCommandFailureCases.filter(({ label }) => label === "signal without output"))(
    "classifies metadata failures with $label",
    async ({ npmResult, expectedDetail }) => {
      runCommandMock.mockResolvedValue(npmResult);

      await expect(
        installNpm({
          spec: "@openclaw/voice-call@0.0.1",
          npmDir: path.join(makeTempDir(), "npm"),
        }),
      ).resolves.toEqual({
        ok: false,
        error: `npm view failed: ${expectedDetail}`,
        code: PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE,
      });
    },
  );

  it("rejects npm pack archive metadata with traversal package names", async () => {
    const stateDir = makeTempDir();
    npmRoot = path.join(stateDir, "npm");
    const victimDir = path.join(stateDir, "victim");
    const archivePath = path.join(stateDir, "evil-pack-1.0.0.tgz");
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "keep.txt"), "keep", "utf8");
    fs.writeFileSync(archivePath, "fixture pack contents", "utf8");

    mockPackages([
      {
        packageName: "@evil/../../../../victim",
        version: "1.0.0",
        npmRoot,
        packArchivePath: archivePath,
      },
    ]);

    const result = await installPackArchive({
      archivePath,
      mode: "update",
    });

    if (result.ok) {
      throw new Error("expected traversal package metadata to be rejected");
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC);
    expect(result.error).toContain("unsupported npm pack package name");
    expect(fs.existsSync(path.join(victimDir, "keep.txt"))).toBe(true);
    expectAbsent(path.join(npmRoot, "package.json"));
    expectAbsent(path.join(npmRoot, "_openclaw-pack-archives"));
    expect(runCommandMock.mock.calls).toHaveLength(1);
  });

  it.each(["rollback", "publication failure", "abort during consent"] as const)(
    "settles a same-generation project replacement with %s",
    async (settlement) => {
      const packageName = "same-generation-plugin";
      const install = (version: string) =>
        installNpm({
          spec: `${packageName}@${version}`,
          mode: "update",
        });
      let targetDir = "";
      for (const version of ["1.0.0", "2.0.0"]) {
        mockPackage({ spec: `${packageName}@${version}`, packageName, version, npmRoot });
        const installed = await install(version);
        assert(installed.ok, JSON.stringify(installed));
        targetDir = installed.targetDir;
      }
      const projectRoot = path.dirname(path.dirname(targetDir));
      const manifestPath = path.join(projectRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        overrides?: Record<string, string>;
        openclaw?: { managedPeerDependencies: string[]; managedOverrides: string[] };
      };
      manifest.overrides = { "existing-override": "1.0.0" };
      manifest.openclaw = {
        managedPeerDependencies: ["original-peer"],
        managedOverrides: ["existing-override"],
      };
      writeJson(manifestPath, manifest);
      fs.writeFileSync(path.join(projectRoot, "original.txt"), "original bytes");
      const original = readTextFileTree(projectRoot);
      mockPackage({
        spec: `${packageName}@2.0.0`,
        version: "2.0.0",
        indexJs: "export const replacement = true;\n",
      });
      const controller = new AbortController();
      let stageRoot = "";
      let refusedPublication = false;
      const rename = fs.promises.rename.bind(fs.promises);
      const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (settlement === "publication failure" && from === stageRoot && to === projectRoot) {
          refusedPublication = true;
          throw Object.assign(new Error("publication refused"), { code: "EIO" });
        }
        return rename(from, to);
      });
      let updated: Awaited<ReturnType<typeof installNpm>>;
      try {
        updated = await installNpm(
          requestDeferredPluginInstall({
            spec: `${packageName}@2.0.0`,
            mode: "update" as const,
            signal: controller.signal,
            onBeforePluginArtifactCommit: async (artifact: PluginInstallArtifactConsentRequest) => {
              stageRoot = path.dirname(path.dirname(artifact.stagedArtifactDir));
              expect(readTextFileTree(projectRoot)).toEqual(original);
              if (settlement === "abort during consent") {
                controller.abort();
              }
            },
          }),
        );
      } finally {
        renameSpy.mockRestore();
      }
      if (settlement === "abort during consent") {
        expect(controller.signal.aborted).toBe(true);
        expect(readTextFileTree(projectRoot)).toEqual(original);
        expect(updated.ok).toBe(false);
        expectAbsent(stageRoot);
        return;
      }
      if (settlement === "publication failure") {
        expect(refusedPublication).toBe(true);
        expect(updated).toMatchObject({
          ok: false,
          error: expect.stringContaining("publication refused"),
        });
        expect(readTextFileTree(projectRoot)).toEqual(original);
        expectAbsent(stageRoot);
        return;
      }
      assert(updated.ok, JSON.stringify(updated));
      expect(updated.targetDir).toBe(targetDir);
      expect(readText(targetDir, "dist", "index.js")).toContain("replacement");
      const transaction = resolvePluginInstallTransaction(updated);
      expect(transaction).toBeDefined();
      await transaction?.rollback();
      expect(readTextFileTree(projectRoot)).toEqual(original);
    },
  );

  it("does not mutate a retained generation when an exact rollback reuses its artifact key", async () => {
    const packageName = "@openclaw/codex";
    const install = async (version: string, options: { mode?: "update" }) =>
      installNpm({
        spec: `${packageName}@${version}`,
        mode: options.mode,
      });

    mockPackage({
      spec: `${packageName}@2.0.0`,
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      indexJs: `module.exports = {
  version: "v2",
  runAttempt: async () => (await import("./run-attempt-v2.js")).default,
};\n`,
      extraDistFiles: {
        "run-attempt-v2.js": "module.exports = { chunk: 'v2' };\n",
      },
      expectedDependencySpec: "2.0.0",
    });
    const first = await install("2.0.0", {});
    assert(first.ok, JSON.stringify(first));
    const retainedModule = await import(
      pathToFileURL(path.join(first.targetDir, "dist", "index.js")).href
    );
    const retainedPackageDir = first.targetDir;

    mockPackage({
      spec: `${packageName}@3.0.0`,
      version: "3.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v3",
      shasum: "codexv3sha",
      indexJs: "module.exports = { version: 'v3' };\n",
      replaceExisting: true,
      expectedDependencySpec: "3.0.0",
    });
    const update = await install("3.0.0", { mode: "update" });
    assert(update.ok, JSON.stringify(update));
    await markRetainedManagedNpmInstall({
      packageDir: retainedPackageDir,
      pluginId: "codex",
      reason: "test-rollback-retention",
    });

    mockPackage({
      spec: `${packageName}@2.0.0`,
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      indexJs: "module.exports = { version: 'v2-rollback' };\n",
      replaceExisting: true,
      expectedDependencySpec: "2.0.0",
    });
    const rollback = await install("2.0.0", { mode: "update" });
    assert(rollback.ok, JSON.stringify(rollback));
    expect(rollback.targetDir).not.toBe(retainedPackageDir);
    await expect(retainedModule.default.runAttempt()).resolves.toEqual({ chunk: "v2" });
    expect(fs.existsSync(path.join(retainedPackageDir, "dist", "run-attempt-v2.js"))).toBe(true);
  });

  it("allocates a fresh generation when a plain install selects a retained artifact", async () => {
    const packageName = "@openclaw/codex";
    const legacyPackageDir = installedPackageDir(npmRoot, packageName);
    const retainedGenerationPackageDir = resolveTestPluginGenerationPackageDir({
      npmRoot,
      packageName,
      version: "2.0.0",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
    });
    fs.mkdirSync(legacyPackageDir, { recursive: true });
    fs.mkdirSync(retainedGenerationPackageDir, { recursive: true });
    for (const packageDir of [legacyPackageDir, retainedGenerationPackageDir]) {
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "codex",
        retainedAt: "2026-04-25T00:00:00.000Z",
        reason: "test-retained-generation",
      });
    }
    const result = await installFixture(`${packageName}@2.0.0`, {
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      expectedDependencySpec: "2.0.0",
    });

    assert(result.ok, JSON.stringify(result));
    expect(result.targetDir).not.toBe(retainedGenerationPackageDir);
    expect(hasRetainedManagedNpmInstallMarker(result.targetDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(retainedGenerationPackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(legacyPackageDir)).toBe(true);
  });

  const metadataFailures: Array<{
    label: string;
    fixture: Partial<MockNpmPackage>;
    errors: string[];
    attempts: number;
    expectedIntegrity?: string;
  }> = [
    {
      label: "integrity drift",
      fixture: { integrity: "sha512-safe", installedIntegrity: "sha512-evil" },
      errors: ["integrity sha512-evil", "expected sha512-safe"],
      attempts: 1,
      expectedIntegrity: "sha512-safe",
    },
    {
      label: "version drift",
      fixture: { installedVersion: "1.0.1" },
      errors: ["version 1.0.1", "expected 1.0.0"],
      attempts: 1,
    },
    {
      label: "missing integrity",
      fixture: { integrity: "sha512-safe", omitInstalledIntegrity: true },
      errors: [
        "metadata remained incomplete after managed npm project recovery",
        "integrity missing",
      ],
      attempts: 2,
      expectedIntegrity: "sha512-safe",
    },
    {
      label: "missing lock entry",
      fixture: { skipLockfileEntry: true },
      errors: ["npm install did not record package-lock metadata for metadata-plugin"],
      attempts: 2,
    },
  ];
  it.each(metadataFailures)(
    "rejects $label without publishing the plugin",
    async ({ fixture, errors, attempts, expectedIntegrity }) => {
      const packageName = "metadata-plugin";
      const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      mockPackage({
        spec: `${packageName}@latest`,
        expectedDependencySpec: "1.0.0",
        ...fixture,
      });
      const result = await installNpm({
        spec: `${packageName}@latest`,
        expectedIntegrity,
      });
      assert(!result.ok, JSON.stringify(result));
      for (const error of errors) {
        expect(result.error).toContain(error);
      }
      expect(
        runCommandMock.mock.calls.filter(([argv]) => isManagedNpmInstallCommand(argv)),
      ).toHaveLength(attempts);
      if (attempts === 2) {
        expectManagedNpmQuarantine([result.error]);
      } else {
        expect(
          fs.existsSync(
            path.join(path.dirname(npmProjectRoot), "_openclaw-quarantined-npm-projects"),
          ),
        ).toBe(false);
      }
      expectAbsent(installedPackageDir(npmRoot, packageName));
    },
  );

  it("preserves the original project and staged quarantine when post-recovery validation fails", async () => {
    const packageName = "unsafe-recovered-plugin";
    const addedPeerName = "recovery-added-peer";
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
    fs.writeFileSync(path.join(npmProjectRoot, "original.txt"), "original bytes", "utf8");
    const originalProject = readTextFileTree(npmProjectRoot);
    const fixture: MockNpmPackage & { spec: string } = {
      spec: `${packageName}@latest`,
      packageName,
      version: "1.0.0",
      pluginId: packageName,
      integrity: "sha512-safe",
      omitInstalledIntegrity: true,
      npmRoot,
      expectedDependencySpec: "1.0.0",
    };
    mockPackages([
      fixture,
      {
        packageName: addedPeerName,
        version: "2.0.0",
        npmRoot,
      },
    ]);
    const delegate = npmDelegate();
    let managedInstallAttempts = 0;
    let attemptedRoot = "";
    const warnings: string[] = [];
    const outsideDependencyDir = makeTempDir();
    runCommandMock.mockImplementation(async (argv, options) => {
      if (
        isManagedNpmInstallCommand(argv) &&
        typeof options?.cwd === "string" &&
        managedNpmRootHasDependency(options.cwd, packageName)
      ) {
        attemptedRoot = options.cwd;
        managedInstallAttempts += 1;
        if (managedInstallAttempts === 1) {
          const corruptPackage = path.join(attemptedRoot, "node_modules", "stale-plugin");
          fs.mkdirSync(corruptPackage, { recursive: true });
          fs.writeFileSync(path.join(corruptPackage, "stale.txt"), "poisoned stage", "utf8");
        }
        if (managedInstallAttempts === 2) {
          fixture.omitInstalledIntegrity = false;
        }
      }
      const commandResult = await delegate(argv, options);
      if (
        managedInstallAttempts === 2 &&
        isManagedNpmInstallCommand(argv) &&
        typeof options?.cwd === "string"
      ) {
        fs.symlinkSync(
          outsideDependencyDir,
          path.join(options.cwd, "node_modules", "outside-dependency"),
          "junction",
        );
      }
      return commandResult;
    });
    let mutatedPeerAfterQuarantine = false;
    const addPeerAfterQuarantine = () => {
      const manifestPath = path.join(attemptedRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
        openclaw?: { managedPeerDependencies?: string[] };
      };
      manifest.dependencies ??= {};
      manifest.dependencies[addedPeerName] = "2.0.0";
      manifest.openclaw ??= {};
      manifest.openclaw.managedPeerDependencies = [addedPeerName];
      writeJson(manifestPath, manifest);
      mutatedPeerAfterQuarantine = true;
    };

    const result = await installNpm({
      spec: fixture.spec,
      expectedIntegrity: fixture.integrity,
      logger: {
        info: () => {},
        warn: (message) => {
          warnings.push(message);
          if (message.includes("quarantined")) {
            addPeerAfterQuarantine();
          }
        },
      },
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED);
    expect(result.error).toContain("installed dependency scan found package outside install root");
    expect(managedInstallAttempts).toBe(2);
    expect(mutatedPeerAfterQuarantine).toBe(true);
    const quarantineDir = expectManagedNpmQuarantine(warnings);
    expect(readText(quarantineDir, "node_modules", "stale-plugin", "stale.txt")).toBe(
      "poisoned stage",
    );
    expect(readTextFileTree(npmProjectRoot)).toEqual(originalProject);
    expectAbsent(installedPackageDir(npmRoot, packageName));
  });

  it("repairs a missing current-platform executable with a fresh npm cache", async () => {
    const { packageName, platformPackage, platformPackageLocation } = mockPlatformPlugin();
    const canonicalPackage = "@vendor/codex";
    const warnings: string[] = [];
    const delegate = npmDelegate();
    let managedInstallAttempts = 0;
    let repairCacheDir = "";
    let removedIncompletePackageBeforeRepair = false;
    runCommandMock.mockImplementation(
      async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        const attemptRoot = options?.cwd;
        const installEnv = options?.env;
        const isTargetInstall = isManagedNpmInstallCommand(argv) && typeof attemptRoot === "string";
        const packageDir = path.join(attemptRoot ?? "", ...platformPackageLocation.split("/"));
        if (isTargetInstall && managedInstallAttempts === 1) {
          removedIncompletePackageBeforeRepair = !fs.existsSync(packageDir);
        }
        const result = await delegate(argv, options);
        if (isTargetInstall) {
          managedInstallAttempts += 1;
          writeMissingCurrentPlatformOptionalPackage({
            npmRoot: attemptRoot,
            packageName: platformPackage,
            packageLocation: platformPackageLocation,
          });
          const lockPath = path.join(attemptRoot, "package-lock.json");
          const lockfile = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
            packages: Record<string, unknown>;
          };
          lockfile.packages[`node_modules/${canonicalPackage}`] = {
            bin: { codex: "bin/codex.js" },
          };
          writeJson(lockPath, lockfile);
          fs.mkdirSync(packageDir, { recursive: true });
          writeJson(path.join(packageDir, "package.json"), {
            name: canonicalPackage,
            version: "1.0.0-platform",
            files: ["vendor"],
          });
          const nativeBinDir = path.join(packageDir, "vendor", "current-platform", "bin");
          fs.mkdirSync(nativeBinDir, { recursive: true });
          if (managedInstallAttempts === 1) {
            fs.writeFileSync(path.join(nativeBinDir, "codex-helper"), "helper", "utf8");
          } else {
            repairCacheDir = installEnv?.npm_config_cache ?? "";
            const executableName = process.platform === "win32" ? "codex.exe" : "codex";
            fs.writeFileSync(path.join(nativeBinDir, executableName), "native executable", {
              encoding: "utf8",
              mode: 0o755,
            });
          }
        }
        return result;
      },
    );

    const result = await installNpm({
      spec: `${packageName}@1.0.0`,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(managedInstallAttempts).toBe(2);
    expect(removedIncompletePackageBeforeRepair).toBe(true);
    expect(repairCacheDir).toContain("openclaw-npm-cache-");
    expectAbsent(repairCacheDir);
    expect(warnings).toContain(
      `npm left current-platform package(s) ${platformPackage} missing or incomplete; retrying once with a fresh cache.`,
    );
  });

  it("rejects installs that still omit current-platform packages after repair", async () => {
    const { packageName, platformPackage, platformPackageLocation } = mockPlatformPlugin();
    const delegate = npmDelegate();
    let managedInstallAttempts = 0;
    runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
      const result = await delegate(argv, options);
      if (isManagedNpmInstallCommand(argv) && typeof options?.cwd === "string") {
        managedInstallAttempts += 1;
        writeMissingCurrentPlatformOptionalPackage({
          npmRoot: options.cwd,
          packageName: platformPackage,
          packageLocation: platformPackageLocation,
        });
      }
      return result;
    });

    const result = await installNpm({
      spec: `${packageName}@1.0.0`,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(managedInstallAttempts).toBe(2);
    expect(result.error).toContain(
      `npm install reported success but left required current-platform package(s) missing or incomplete: ${platformPackage}`,
    );
    expectAbsent(installedPackageDir(npmRoot, packageName));
  });

  it("keeps corrupt managed npm project artifacts quarantined when the rebuild retry fails", async () => {
    const packageName = "broken-plugin";
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(npmProjectRoot, "original.txt"), "original bytes", "utf8");
    const originalProject = readTextFileTree(npmProjectRoot);

    mockPackage({
      spec: `${packageName}@1.0.0`,
      expectedDependencySpec: "1.0.0",
    });
    const delegate = npmDelegate();
    let managedInstallAttempts = 0;
    runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
      if (isManagedNpmInstallCommand(argv) && typeof options?.cwd === "string") {
        managedInstallAttempts += 1;
        if (managedInstallAttempts === 1) {
          const stalePackageDir = path.join(options.cwd, "node_modules", "stale-plugin");
          fs.mkdirSync(stalePackageDir, { recursive: true });
          fs.writeFileSync(path.join(stalePackageDir, "stale.txt"), "corrupt stage", "utf8");
          return failedSpawn(
            'npm ERR! code ERR_INVALID_ARG_TYPE\nnpm ERR! The "from" argument must be of type string. Received undefined',
          );
        }
        return failedSpawn("npm ERR! still broken");
      }
      return await delegate(argv, options);
    });

    const result = await installNpm({
      spec: `${packageName}@1.0.0`,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(managedInstallAttempts).toBe(2);
    expect(result.error).toContain("npm install failed after managed npm project recovery");
    expect(result.error).toContain("Original npm error");
    const quarantineDir = expectManagedNpmQuarantine([result.error]);
    expect(readText(quarantineDir, "node_modules", "stale-plugin", "stale.txt")).toBe(
      "corrupt stage",
    );
    expect(readTextFileTree(npmProjectRoot)).toEqual(originalProject);
    expectAbsent(installedPackageDir(npmRoot, packageName));
  });

  it("rejects managed npm plugins when their openclaw peer link cannot be repaired", async () => {
    const warnings: string[] = [];

    resolveOpenClawPackageRootSyncMock.mockReturnValue(null);
    mockPackage({
      spec: "@openclaw/codex@2026.5.7",
      version: "2026.5.7",
      peerDependencies: { openclaw: ">=2026.5.7" },
    });

    const result = await installNpm({
      spec: "@openclaw/codex@2026.5.7",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.error).toContain("@openclaw/codex");
    expect(result.error).toContain("plugin-local node_modules/openclaw link");
    expect(
      warnings.some((warning) => warning.includes("Could not locate openclaw package root")),
    ).toBe(true);
    expectAbsent(installedPackageDir(npmRoot, "@openclaw/codex"));
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@openclaw/codex",
    });
    expectAbsent(path.join(npmProjectRoot, "package.json"));
  });

  it("rejects exact npm plugins whose package compatibility requires a newer host", async () => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.10-beta.1");

    const result = await installFixture("@openclaw/whatsapp@2026.5.27", {
      version: "2026.5.27",
      pluginId: "whatsapp",
      peerDependencies: { openclaw: ">=2026.5.27" },
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { minHostVersion: ">=2026.4.25" },
        compat: { pluginApi: ">=2026.5.27" },
      },
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(result.error).toContain("requires plugin API >=2026.5.27");
    expect(result.error).toContain("runtime exposes 2026.5.10-beta.1");
    expect(result.error).toContain("install a compatible plugin version");
    expectAbsent(path.join(npmRoot, "node_modules", "@openclaw", "whatsapp"));
    expectAbsent(path.join(npmRoot, "package.json"));
    expect(runCommandMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv))).toBe(
      false,
    );
  });

  it("preserves an existing npm plugin by resolving update metadata to a compatible version", async () => {
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@openclaw/whatsapp",
    });
    const warnings: string[] = [];
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    writeJson(path.join(npmProjectRoot, "package.json"), {
      private: true,
      dependencies: {
        "@openclaw/whatsapp": "2026.5.26",
      },
    });
    writeInstalledNpmPlugin({
      packageName: "@openclaw/whatsapp",
      version: "2026.5.26",
      pluginId: "whatsapp",
      npmRoot: npmProjectRoot,
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { minHostVersion: ">=2026.4.25" },
        compat: { pluginApi: ">=2026.5.10-beta.1" },
      },
    });
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.10-beta.1");
    mockPackages([
      {
        spec: "@openclaw/whatsapp",
        packageName: "@openclaw/whatsapp",
        version: "2026.5.27",
        pluginId: "whatsapp",
        npmRoot,
        versions: ["2026.5.26", "2026.5.27"],
        openclaw: {
          extensions: ["./dist/index.js"],
          install: { minHostVersion: ">=2026.4.25" },
          compat: { pluginApi: ">=2026.5.27" },
        },
      },
      {
        spec: "@openclaw/whatsapp@2026.5.26",
        packageName: "@openclaw/whatsapp",
        version: "2026.5.26",
        pluginId: "whatsapp",
        npmRoot,
        expectedDependencySpec: "2026.5.26",
        openclaw: {
          extensions: ["./dist/index.js"],
          install: { minHostVersion: ">=2026.4.25" },
          compat: { pluginApi: ">=2026.5.10-beta.1" },
        },
      },
    ]);

    const result = await installNpm({
      spec: "@openclaw/whatsapp",
      mode: "update",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(result.ok, JSON.stringify(result));
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/whatsapp@2026.5.26");
    expect(warnings.join("\n")).toContain("using newest compatible @openclaw/whatsapp@2026.5.26");
    expect(
      JSON.parse(readText(installedPackageDir(npmRoot, "@openclaw/whatsapp"), "package.json"))
        .version,
    ).toBe("2026.5.26");
    const managedManifest = readManifest(npmProjectRoot);
    expect(managedManifest.dependencies?.["@openclaw/whatsapp"]).toBe("2026.5.26");
    expect(runCommandMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv))).toBe(true);
  });

  it("does not resolve explicit prerelease tags to stable compatible versions", async () => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.28-beta.3");

    mockPackages([
      {
        spec: "@openclaw/msteams@beta",
        packageName: "@openclaw/msteams",
        version: "2026.5.28-beta.4",
        pluginId: "msteams",
        npmRoot,
        versions: ["2026.5.27", "2026.5.28-beta.4"],
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.5.28-beta.4" },
        },
      },
    ]);

    const result = await installNpm({
      spec: "@openclaw/msteams@beta",
      mode: "update",
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(result.error).toContain("requires plugin API >=2026.5.28-beta.4");
    expect(runCommandMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv))).toBe(
      false,
    );
  });

  it.runIf(process.platform !== "win32")(
    "repairs root openclaw materialized by npm peer handling",
    async () => {
      mockPackage({
        spec: "required-peer-plugin@1.0.0",
        peerDependencies: { openclaw: "^2026.0.0" },
        materializesRootOpenClaw: true,
      });

      const result = await installNpm({
        spec: "required-peer-plugin@1.0.0",
      });

      expect(result.ok).toBe(true);
      const npmProjectRoot = resolvePluginNpmProjectDir({
        npmDir: npmRoot,
        packageName: "required-peer-plugin",
      });
      const requiredPeerPluginDir = installedPackageDir(npmRoot, "required-peer-plugin");
      expectAbsent(path.join(npmProjectRoot, "node_modules", "openclaw"));
      const lockfile = readLockfile(npmProjectRoot);
      expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
      expect(
        fs.lstatSync(path.join(requiredPeerPluginDir, "node_modules", "openclaw")).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it("repairs stale managed openclaw root packages before npm plugin installs", async () => {
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@openclaw/discord",
    });
    fs.mkdirSync(path.join(npmProjectRoot, "node_modules", "openclaw"), { recursive: true });
    writeJson(path.join(npmProjectRoot, "package.json"), {
      private: true,
      dependencies: {
        openclaw: "2026.5.4",
      },
    });
    writeJson(path.join(npmProjectRoot, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            openclaw: "2026.5.4",
          },
        },
        "node_modules/openclaw": {
          version: "2026.5.4",
          resolved: "https://registry.npmjs.org/openclaw/-/openclaw-2026.5.4.tgz",
        },
      },
      dependencies: {
        openclaw: {
          version: "2026.5.4",
        },
      },
    });
    writeJson(path.join(npmProjectRoot, "node_modules", "openclaw", "package.json"), {
      name: "openclaw",
      version: "2026.5.4",
    });

    const result = await installFixture("@openclaw/discord@beta", {
      version: "2026.5.5-beta.1",
      pluginId: "discord",
      peerDependencies: { openclaw: ">=2026.5.5-beta.1" },
      expectedDependencySpec: "2026.5.5-beta.1",
    });

    expect(result.ok).toBe(true);
    const manifest = readManifest(npmProjectRoot);
    expect(manifest.dependencies).not.toHaveProperty("openclaw");
    expect(manifest.dependencies?.["@openclaw/discord"]).toBe("2026.5.5-beta.1");
    const lockfile = readLockfile(npmProjectRoot);
    expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
    expect(lockfile.dependencies?.openclaw).toBeUndefined();
  });

  it("preserves the active host openclaw runtime package during npm plugin installs", async () => {
    const hostPackageRoot = path.join(npmRoot, "node_modules", "openclaw");
    fs.mkdirSync(hostPackageRoot, { recursive: true });
    writeJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        openclaw: "2026.5.12-beta.6",
      },
    });
    writeJson(path.join(npmRoot, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            openclaw: "2026.5.12-beta.6",
          },
        },
        "node_modules/openclaw": {
          version: "2026.5.12-beta.6",
        },
      },
    });
    writeJson(path.join(hostPackageRoot, "package.json"), {
      name: "openclaw",
      version: "2026.5.12-beta.6",
    });

    resolveOpenClawPackageRootSyncMock.mockReturnValue(hostPackageRoot);
    const result = await installFixture("@xdarkicex/openclaw-memory-libravdb@1.4.69", {
      version: "1.4.69",
      pluginId: "libravdb-memory",
      expectedDependencySpec: "1.4.69",
    });

    assert(result.ok, JSON.stringify(result));
    const baseManifest = readManifest(npmRoot);
    expect(baseManifest.dependencies?.openclaw).toBe("2026.5.12-beta.6");
    expect(baseManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBeUndefined();
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@xdarkicex/openclaw-memory-libravdb",
    });
    const projectManifest = readManifest(npmProjectRoot);
    expect(projectManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBe("1.4.69");
    expect(fs.existsSync(hostPackageRoot)).toBe(true);
    expect(result.targetDir).toBe(
      installedPackageDir(npmRoot, "@xdarkicex/openclaw-memory-libravdb"),
    );
    expect(
      runCommandMock.mock.calls.some(
        ([argv]) =>
          Array.isArray(argv) &&
          npmCommandArgs(argv)?.[0] === "uninstall" &&
          argv.includes("openclaw"),
      ),
    ).toBe(false);
  });

  registerManagedNpmDependencyTests({
    makeTempDir,
    writeInstalledNpmPlugin,
    mockNpmViewAndInstall: mockPackage,
    runCommandWithTimeoutMock: runCommandMock,
    resolveOpenClawPackageRootSyncMock,
    installPluginFromNpmSpec: installNpm,
    resolveTestPluginPackageDir: installedPackageDir,
    isManagedNpmInstallCommand,
  });

  it("restores the managed project after a post-install throw and allows retry", async () => {
    const stateDir = makeTempDir();
    const packageName = "throw-rollback-package";
    const pluginId = "throw-rollback-plugin";
    const spec = `${packageName}@1.0.0`;
    const archivePath = path.join(stateDir, "plugin.tgz");
    fs.writeFileSync(archivePath, "fixture archive", "utf8");
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    writeInstalledNpmPlugin({
      npmRoot: npmProjectRoot,
      packageName: "existing-package",
      version: "1.0.0",
    });
    fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
    fs.writeFileSync(path.join(npmProjectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    const projectBefore = readTextFileTree(npmProjectRoot);
    mockPackages([
      { spec, packArchivePath: archivePath, packageName, pluginId, version: "1.0.0", npmRoot },
    ]);
    const failure = new Error("post-install logger failure");
    const info = vi.fn((message: string) => {
      if (message.startsWith("Plugin manifest id")) {
        expect(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);
        throw failure;
      }
    });
    const install = () => {
      const params = requestDeferredPluginInstall({ npmDir: npmRoot, logger: { info } });
      return installPackArchive({ ...params, archivePath });
    };

    await expect(install()).rejects.toBe(failure);
    expect.soft(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);

    info.mockImplementation(() => {});
    const retry = await install();
    expect(retry).toMatchObject({ ok: true, pluginId });
    await resolvePluginInstallTransaction(retry)?.commit();
    expect(fs.existsSync(installedPackageDir(npmRoot, packageName))).toBe(true);
  });

  it("preserves an empty managed project after refused npm-pack relocation and permits retry", async () => {
    const stateDir = makeTempDir();
    const packageName = "relocation-fixture";
    const spec = `${packageName}@1.0.0`;
    const archivePath = path.join(stateDir, "plugin.tgz");
    fs.writeFileSync(archivePath, "fixture archive", "utf8");
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    mockPackages([{ spec, packArchivePath: archivePath, packageName, version: "1.0.0", npmRoot }]);
    const refused = new Error("artifact consent refused");
    const onBeforePluginArtifactCommit = vi.fn(async () => {});
    onBeforePluginArtifactCommit.mockRejectedValueOnce(refused);
    const install = () => {
      const params = {
        mode: "update" as const,
        onBeforePluginArtifactCommit,
      };
      return installPackArchive({ ...params, archivePath });
    };
    await expect(install()).rejects.toBe(refused);
    expect(fs.existsSync(npmProjectRoot)).toBe(true);
    expect(fs.readdirSync(npmProjectRoot)).toEqual([]);
    const retry = await install();
    expect(retry).toMatchObject({ ok: true, pluginId: packageName });
    expect(
      fs.existsSync(path.join(installedPackageDir(npmRoot, packageName), "dist", "index.js")),
    ).toBe(true);
  });

  it("preserves host peer links across a staged npm update ending in failure", async () => {
    const packageName = "@openclaw/peer-fixture";
    const hostRoot = makeTempDir();
    fs.writeFileSync(
      path.join(hostRoot, "package.json"),
      '{"name":"openclaw","version":"0.0.0-test"}\n',
    );
    resolveOpenClawPackageRootSyncMock.mockReturnValue(hostRoot);
    const fixture = (version: string) => ({
      spec: `${packageName}@${version}`,
      packageName,
      pluginId: "peer-fixture",
      version,
      npmRoot,
      peerDependencies: { openclaw: "*" },
    });
    mockPackage(fixture("1.0.0"));
    const first = await installNpm({
      spec: `${packageName}@1.0.0`,
    });
    assert(first.ok, JSON.stringify(first));
    const oldPeerLink = path.join(first.targetDir, "node_modules", "openclaw");
    await expect(fs.promises.realpath(oldPeerLink)).resolves.toBe(
      await fs.promises.realpath(hostRoot),
    );
    mockPackage(fixture("2.0.0"));
    const delegate = npmDelegate();
    runCommandMock.mockImplementation(async (argv, options) =>
      isManagedNpmInstallCommand(argv)
        ? failedSpawn("registry unavailable")
        : delegate(argv, options),
    );
    const onBeforePluginArtifactCommit = vi.fn(async () => {});
    const updated = await installNpm({
      spec: `${packageName}@2.0.0`,
      mode: "update",
      onBeforePluginArtifactCommit,
    });
    assert(!updated.ok, JSON.stringify(updated));
    expect(onBeforePluginArtifactCommit).not.toHaveBeenCalled();
    expect(updated.error).toContain("registry unavailable");
    await expect(fs.promises.realpath(oldPeerLink)).resolves.toBe(
      await fs.promises.realpath(hostRoot),
    );
  });

  it("normalizes selectors before npm planning and retries only unsupported aliases", async () => {
    const hostRoot = makeTempDir();
    writeJson(path.join(hostRoot, "package.json"), {
      name: "openclaw",
    });
    fs.writeFileSync(
      path.join(hostRoot, "pnpm-workspace.yaml"),
      [
        "overrides:",
        "  axios: 1.18.0",
        '  node-domexception: "npm:@nolyfill/domexception@1.0.28"',
        '  "range-target@>1": 2.0.0',
        '  "werift-ice@0.2.2>ip": "npm:neoip@3.1.0"',
        "  nested:",
        '    alias: "npm:@scope/alias@1.0.0"',
        "    semver: 1.2.3",
        "",
      ].join("\n"),
      "utf8",
    );
    resolveOpenClawPackageRootSyncMock.mockReturnValue(hostRoot);
    mockPackage({
      spec: "@openclaw/voice-call@0.0.1",
      version: "0.0.1",
      pluginId: "voice-call",
    });
    const baseImplementation = runCommandMock.getMockImplementation();
    let installAttempts = 0;
    runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
      if (isNpmPeerPlannerInstallCommand(argv)) {
        const manifest = JSON.parse(readText(options?.cwd ?? "", "package.json")) as {
          overrides?: Record<string, unknown>;
        };
        expect(manifest.overrides).not.toHaveProperty("werift-ice@0.2.2>ip");
        expect(manifest.overrides?.["range-target@>1"]).toBe("2.0.0");
      }
      if (isManagedNpmInstallCommand(argv)) {
        installAttempts += 1;
        const npmProjectRoot = options?.cwd;
        if (!npmProjectRoot) {
          throw new Error("expected npm install cwd");
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(npmProjectRoot, "package.json"), "utf8"),
        ) as { overrides?: Record<string, unknown>; openclaw?: { managedOverrides?: string[] } };
        if (installAttempts === 1) {
          expect(manifest.overrides?.["node-domexception"]).toBe(
            "npm:@nolyfill/domexception@1.0.28",
          );
          expect(manifest.overrides?.["range-target@>1"]).toBe("2.0.0");
          expect(manifest.overrides).not.toHaveProperty("werift-ice@0.2.2>ip");
          expect(manifest.overrides).toEqual({
            axios: "1.18.0",
            nested: {
              alias: "npm:@scope/alias@1.0.0",
              semver: "1.2.3",
            },
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
            "range-target@>1": "2.0.0",
          });
          expect(manifest.openclaw?.managedOverrides).toEqual([
            "axios",
            "nested",
            "node-domexception",
            "range-target@>1",
          ]);
          return failedSpawn("npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28");
        }
        expect(manifest.overrides).toEqual({
          axios: "1.18.0",
          nested: {
            semver: "1.2.3",
          },
          "range-target@>1": "2.0.0",
        });
        expect(manifest.openclaw?.managedOverrides).toEqual(["axios", "nested", "range-target@>1"]);
      }
      return await baseImplementation?.(argv, options);
    });

    const warnings: string[] = [];
    const result = await installNpm({
      spec: "@openclaw/voice-call@0.0.1",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(installAttempts).toBe(2);
    expect(warnings).toEqual([
      "npm rejected managed npm overrides; retrying plugin install without npm-incompatible overrides for this npm version.",
    ]);
  });

  it("rejects a trusted official npm plugin with a malformed manifest", async () => {
    const packageName = "@openclaw/official-malformed";
    const expectedPluginId = "official-malformed";
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName,
    });
    mockPackage({
      spec: packageName,
      packageName,
      version: "0.0.0",
      pluginId: expectedPluginId,
      nativeManifest: "malformed",
    });

    const result = await installNpm({
      spec: packageName,
      expectedPluginId,
      trustedSourceLinkedOfficialInstall: true,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.MISSING_PLUGIN_MANIFEST);
    expect(result.error).toContain("package missing valid openclaw.plugin.json");
    expect(result.error).not.toContain("plugin id mismatch");
    expectAbsent(
      installedPackageDir(npmRoot, packageName),
      ...["package.json", "package-lock.json", "node_modules"].map((name) =>
        path.join(npmProjectRoot, name),
      ),
    );
  });

  it("preserves untrusted manifestless npm updates keyed by the legacy package name", async () => {
    const packageName = "@third-party/legacy-plugin";
    const result = await installFixture(
      packageName,
      { nativeManifest: "missing" },
      {
        expectedPluginId: "legacy-plugin",
        trustedSourceLinkedOfficialInstall: false,
        mode: "update",
      },
    );

    expect(result).toMatchObject({ ok: true, pluginId: packageName });
    expect(fs.existsSync(installedPackageDir(npmRoot, packageName))).toBe(true);
  });

  it("accepts a trusted manifest-declared plugin id replacement during update", async () => {
    const result = await installFixture(
      "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      {
        version: "2026.8.1-beta.0",
        pluginId: "fish-audio-speech",
        legacyPluginIds: ["fish-audio"],
      },
      {
        mode: "update",
        expectedPluginId: "fish-audio",
        expectedReplacementPluginId: "fish-audio-speech",
        trustedSourceLinkedOfficialInstall: true,
      },
    );

    expect(result).toMatchObject({ ok: true, pluginId: "fish-audio-speech" });
  });

  it("accepts a trusted catalog lookup id replacement during update", async () => {
    const result = await installFixture(
      "@tencent-connect/openclaw-qqbot@2.0.3",
      {
        version: "2.0.3",
        pluginId: "openclaw-qqbot",
      },
      {
        mode: "update",
        expectedPluginId: "qqbot",
        expectedReplacementPluginId: "openclaw-qqbot",
        trustedSourceLinkedOfficialInstall: true,
      },
    );

    expect(result).toMatchObject({ ok: true, pluginId: "openclaw-qqbot" });
  });

  it.each([
    {
      name: "untrusted source",
      mode: "update" as const,
      trustedSourceLinkedOfficialInstall: false,
      expectedReplacementPluginId: "fish-audio-speech",
      legacyPluginIds: ["fish-audio"],
    },
    {
      name: "different catalog replacement",
      mode: "update" as const,
      trustedSourceLinkedOfficialInstall: true,
      expectedReplacementPluginId: "different-plugin",
      legacyPluginIds: ["fish-audio"],
    },
    {
      name: "fresh install",
      mode: "install" as const,
      trustedSourceLinkedOfficialInstall: true,
      expectedReplacementPluginId: "fish-audio-speech",
      legacyPluginIds: ["fish-audio"],
    },
    {
      name: "manifest without the legacy id",
      mode: "update" as const,
      trustedSourceLinkedOfficialInstall: true,
      expectedReplacementPluginId: "fish-audio-speech",
      legacyPluginIds: undefined,
    },
  ])("rejects a manifest id replacement for a $name", async (testCase) => {
    mockPackage({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      version: "2026.8.1-beta.0",
      pluginId: "fish-audio-speech",
      legacyPluginIds: testCase.legacyPluginIds,
    });

    const result = await installNpm({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      mode: testCase.mode,
      expectedPluginId: "fish-audio",
      expectedReplacementPluginId: testCase.expectedReplacementPluginId,
      trustedSourceLinkedOfficialInstall: testCase.trustedSourceLinkedOfficialInstall,
    });

    expect(result).toMatchObject({ ok: false, code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH });
  });

  it("rejects non-registry npm specs", async () => {
    const result = await installNpm({ spec: "github:evil/evil" });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported npm spec"),
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    });
  });

  it("rejects duplicate npm installs unless update mode is requested", async () => {
    const installRoot = installedPackageDir(npmRoot, "@openclaw/voice-call");
    fs.mkdirSync(installRoot, { recursive: true });
    mockNpmViewMetadataResult(runCommandMock, {
      name: "@openclaw/voice-call",
      version: "0.0.1",
      integrity: "sha512-plugin-test",
      shasum: "pluginshasum",
    });

    const result = await installNpm({
      spec: "@openclaw/voice-call@0.0.1",
      mode: "install",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin already exists");
      expect(result.error).toContain(installRoot);
    }
    expect(
      runCommandMock.mock.calls.some(
        (call) => Array.isArray(call[0]) && npmCommandArgs(call[0])?.[0] === "install",
      ),
    ).toBe(false);
  });

  it("classifies npm package-not-found errors with a stable error code", async () => {
    runCommandMock.mockResolvedValue(
      failedSpawn(
        "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope",
      ),
    );

    const result = await installNpm({
      spec: "@openclaw/not-found",
    });
    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
    });
  });

  it("rejects implicit prerelease npm specs with beta guidance", async () => {
    mockNpmViewMetadataResult(runCommandMock, {
      name: "@openclaw/voice-call",
      version: "0.0.2-beta.1",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });

    const rejected = await installNpm({
      spec: "@openclaw/voice-call",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("prerelease version 0.0.2-beta.1");
      expect(rejected.error).toContain('"npm:@openclaw/voice-call@beta"');
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
