import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import {
  createCommandResult,
  mockNpmViewMetadataResult,
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

// mock-isolation: npm installation tests supply command results without invoking npm.
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
  PLUGIN_INSTALL_ERROR_CODE: ERR,
} = await import("./install.js");

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-npm-spec");
const makeTempDir = () => suiteTempRootTracker.makeTempDir();
let previousNpmGlobalConfig: string | undefined;
let npmGlobalConfigPath: string;
let npmRoot: string;
let hostRoot: string;
const silentLogger = { info: () => {}, warn: () => {} };
type InstallParams = Parameters<typeof installSpec>[0];
type InstallResult = Awaited<ReturnType<typeof installSpec>>;
type InstallFailure = Extract<InstallResult, { ok: false }>;
function expectFailure(
  result: InstallResult,
  code: InstallFailure["code"],
  ...messages: string[]
): asserts result is InstallFailure {
  assert(!result.ok, JSON.stringify(result));
  if (code !== undefined) {
    expect(result.code).toBe(code);
  }
  for (const message of messages) {
    expect(result.error).toContain(message);
  }
}
function installNpm(params: InstallParams | string, options: Omit<InstallParams, "spec"> = {}) {
  return installSpec({
    npmDir: npmRoot,
    logger: silentLogger,
    ...(typeof params === "string" ? { spec: params, ...options } : params),
  });
}
function installPackArchive(params: Parameters<typeof installPack>[0]) {
  return installPack({ npmDir: npmRoot, logger: silentLogger, ...params });
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function writeText(filePath: string, contents: string) {
  fs.writeFileSync(filePath, contents, "utf8");
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
function expectPresent(...parts: string[]) {
  expect(fs.existsSync(path.join(...parts))).toBe(true);
}
function warningLogger(warnings: string[]) {
  return { ...silentLogger, warn: (message: string) => warnings.push(message) };
}
function npmDelegate() {
  const delegate = runCommandMock.getMockImplementation();
  if (!delegate) {
    throw new Error("expected npm mock implementation");
  }
  return delegate;
}

type Spawn = ReturnType<typeof createCommandResult>;
function interceptInstalls(
  run: (root: string, next: () => Promise<Spawn>, env?: NodeJS.ProcessEnv) => Promise<Spawn>,
) {
  const delegate = npmDelegate();
  runCommandMock.mockImplementation(
    async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const next = () => delegate(argv, options);
      return isManagedNpmInstallCommand(argv) && typeof options?.cwd === "string"
        ? run(options.cwd, next, options.env)
        : next();
    },
  );
}

function successfulSpawn(stdout = "") {
  return createCommandResult({ stdout });
}
function failedSpawn(stderr: string, stdout = "") {
  return { ...successfulSpawn(stdout), code: 1, stderr };
}

function npmViewArgs(spec: string): string[] {
  return ["view", spec, "name", "version", "dist.integrity", "dist.shasum", "openclaw", "--json"];
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

function projectDir(packageName: string, npmDir = npmRoot) {
  return resolvePluginNpmProjectDir({ npmDir, packageName });
}

function managedInstalls() {
  return runCommandMock.mock.calls.filter(([argv]) => isManagedNpmInstallCommand(argv));
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
  return path.join(projectDir(packageName, projectRoot), "node_modules", ...packageName.split("/"));
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
    writeText(
      path.join(pluginDir, "openclaw.plugin.json"),
      params.nativeManifest === "malformed"
        ? "{invalid plugin manifest"
        : JSON.stringify({
            id: params.pluginId ?? params.packageName,
            name: params.pluginId ?? params.packageName,
            ...(params.legacyPluginIds ? { legacyPluginIds: params.legacyPluginIds } : {}),
            configSchema: { type: "object" },
          }),
    );
  }
  writeText(path.join(pluginDir, "dist", "index.js"), params.indexJs ?? "export {};");
  for (const [relativePath, contents] of Object.entries(params.extraDistFiles ?? {})) {
    const targetPath = path.join(pluginDir, "dist", relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    writeText(targetPath, contents);
  }
  if (params.dependency) {
    writeDependency(pluginDir, params.dependency);
  }
  return pluginDir;
}

function writeDependency(root: string, dependency: { name: string; version: string }) {
  const depDir = path.join(root, "node_modules", dependency.name);
  fs.mkdirSync(depDir, { recursive: true });
  writeJson(path.join(depDir, "package.json"), dependency);
}

function makePackage(
  packageName: string,
  version: string,
  overrides: Partial<MockNpmPackage> = {},
): MockNpmPackage & { spec: string } {
  return { spec: `${packageName}@${version}`, packageName, version, npmRoot, ...overrides };
}
function codexPackage(version: string, overrides: Partial<MockNpmPackage> = {}) {
  const major = version.split(".")[0];
  return makePackage("@openclaw/codex", version, {
    pluginId: "codex",
    integrity: `sha512-codex-v${major}`,
    shasum: `codexv${major}sha`,
    expectedDependencySpec: version,
    ...overrides,
  });
}
function whatsappPackage(
  version: string,
  apiVersion = version,
  overrides: Partial<MockNpmPackage> = {},
) {
  return makePackage("@openclaw/whatsapp", version, {
    pluginId: "whatsapp",
    openclaw: {
      extensions: ["./dist/index.js"],
      install: { minHostVersion: ">=2026.4.25" },
      compat: { pluginApi: `>=${apiVersion}` },
    },
    ...overrides,
  });
}

function writeHostProject(root: string, version: string, legacy = false) {
  const dependencies = { openclaw: version };
  writeDependency(root, { name: "openclaw", version });
  writeJson(path.join(root, "package.json"), { private: true, dependencies });
  writeJson(path.join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies },
      "node_modules/openclaw": {
        version,
        ...(legacy
          ? { resolved: `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz` }
          : {}),
      },
    },
    ...(legacy ? { dependencies: { openclaw: { version } } } : {}),
  });
}

function fishPackage(overrides: Partial<MockNpmPackage> = {}) {
  return makePackage("@openclaw/fish-audio-speech", "2026.8.1-beta.0", {
    pluginId: "fish-audio-speech",
    legacyPluginIds: ["fish-audio"],
    ...overrides,
  });
}
type Replacement = {
  fixture?: ReturnType<typeof fishPackage>;
  mode?: "install" | "update";
  trusted?: boolean;
  expectedId?: string;
  replacementId?: string;
};
async function installReplacement({
  fixture = fishPackage(),
  mode = "update",
  trusted = true,
  expectedId = "fish-audio",
  replacementId = "fish-audio-speech",
}: Replacement = {}) {
  mockPackages([fixture]);
  return installNpm(fixture.spec, {
    mode,
    trustedSourceLinkedOfficialInstall: trusted,
    expectedPluginId: expectedId,
    expectedReplacementPluginId: replacementId,
  });
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
  peerDependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  expectedDependencySpec?: string;
  versions?: string[];
  installedVersion?: string;
  installedIntegrity?: string;
  omitInstalledIntegrity?: boolean;
  materializesRootOpenClaw?: boolean;
  skipLockfileEntry?: boolean;
  packArchivePath?: string;
  replaceExisting?: boolean;
};

function writeNpmRootPackageLock(params: {
  npmRoot: string;
  dependencies: Record<string, string>;
  packages: MockNpmPackage[];
}) {
  const lockPackages: Record<string, unknown> = { "": { dependencies: params.dependencies } };
  for (const pkg of params.packages) {
    if (pkg.skipLockfileEntry) {
      continue;
    }
    lockPackages[`node_modules/${pkg.packageName}`] = {
      version: pkg.installedVersion ?? pkg.version,
      ...(pkg.omitInstalledIntegrity
        ? {}
        : { integrity: pkg.installedIntegrity ?? pkg.integrity ?? "sha512-plugin-test" }),
    };
    if (pkg.materializesRootOpenClaw) {
      lockPackages["node_modules/openclaw"] = { peer: true, version: "2026.5.3" };
    }
  }
  writeJson(path.join(params.npmRoot, "package-lock.json"), {
    lockfileVersion: 3,
    packages: lockPackages,
  });
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

function mockPackages(packages: MockNpmPackage[]) {
  const packagesByName = new Map(packages.map((pkg) => [pkg.packageName, pkg]));
  const responses = new Map<string, () => unknown>();
  for (const pkg of packages) {
    const metadata = () => ({
      name: pkg.packageName,
      version: pkg.version,
      integrity: pkg.integrity ?? "sha512-plugin-test",
      shasum: pkg.shasum ?? "pluginshasum",
    });
    if (pkg.packArchivePath) {
      responses.set(commandKey(npmPackArchiveMetadataArgs(pkg.packArchivePath)), () => [
        {
          ...metadata(),
          id: `${pkg.packageName}@${pkg.version}`,
          filename: `${pkg.packageName.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`,
        },
      ]);
    }
    if (pkg.spec) {
      responses.set(commandKey(npmViewArgs(pkg.spec)), () => {
        const { name, version, integrity, shasum } = metadata();
        return {
          name,
          version,
          dist: { integrity, shasum },
          ...(pkg.openclaw ? { openclaw: pkg.openclaw } : {}),
        };
      });
    }
    if (pkg.versions) {
      responses.set(
        commandKey(["view", pkg.packageName, "versions", "--json"]),
        () => pkg.versions ?? [pkg.version],
      );
    }
  }
  runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
    const npmArgs = npmCommandArgs(argv);
    if (!npmArgs) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    const response = responses.get(commandKey(npmArgs));
    if (response) {
      return successfulSpawn(JSON.stringify(response()));
    }
    if (npmArgs[0] === "install") {
      const planner = isNpmPeerPlannerInstallCommand(argv);
      const projectRoot = options?.cwd;
      if (!projectRoot) {
        throw new Error(
          `unexpected npm ${planner ? "peer planner" : "install"} command: ${argv.join(" ")}`,
        );
      }
      const dependencies = readManifest(projectRoot).dependencies ?? {};
      const installedPackages: MockNpmPackage[] = [];
      if (!planner) {
        prunePluginLocalOpenClawPeerLinks(projectRoot);
      }
      for (const packageName of Object.keys(dependencies)) {
        const pkg = packagesByName.get(packageName);
        if (planner) {
          if (pkg) {
            installedPackages.push(pkg);
          }
          continue;
        }
        if (packageName === "openclaw") {
          writeDependency(projectRoot, { name: "openclaw", version: "0.0.0-test" });
          continue;
        }
        if (!pkg) {
          throw new Error(`unexpected managed npm dependency: ${packageName}`);
        }
        const dependencySpec = dependencies[packageName];
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
          writeDependency(projectRoot, { name: "openclaw", version: "2026.5.3" });
        }
        installedPackages.push(pkg);
      }
      writeNpmRootPackageLock({ npmRoot: projectRoot, dependencies, packages: installedPackages });
      return successfulSpawn();
    }
    if (npmArgs[0] === "uninstall") {
      const packageName = argv.at(-1);
      const pkg =
        packageName === "openclaw"
          ? { packageName, npmRoot: options?.cwd }
          : packageName
            ? packagesByName.get(packageName)
            : undefined;
      if (!pkg) {
        throw new Error(`unexpected npm uninstall package: ${packageName ?? ""}`);
      }
      const root = options?.cwd ?? pkg.npmRoot;
      if (root === undefined || (packageName === "openclaw" && !root)) {
        throw new Error(`unexpected npm uninstall command: ${argv.join(" ")}`);
      }
      fs.rmSync(path.join(root, "node_modules", ...pkg.packageName.split("/")), {
        recursive: true,
        force: true,
      });
      return successfulSpawn();
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
}

beforeAll(() => {
  previousNpmGlobalConfig = process.env.NPM_CONFIG_GLOBALCONFIG;
  npmGlobalConfigPath = path.join(makeTempDir(), "global-npmrc");
  writeText(npmGlobalConfigPath, "");
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
  hostRoot = makeTempDir();
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

  it("classifies metadata failures with a signal and no output", async () => {
    runCommandMock.mockResolvedValue(
      createCommandResult({ code: null, signal: "SIGKILL", killed: true, termination: "signal" }),
    );
    await expect(installNpm("@openclaw/voice-call@0.0.1")).resolves.toEqual({
      ok: false,
      error: "npm view failed: signal SIGKILL (no output from npm)",
      code: ERR.NPM_METADATA_FAILURE,
    });
  });

  it("rejects npm pack archive metadata with traversal package names", async () => {
    const stateDir = makeTempDir();
    npmRoot = path.join(stateDir, "npm");
    const victimDir = path.join(stateDir, "victim");
    const archivePath = path.join(stateDir, "evil-pack-1.0.0.tgz");
    fs.mkdirSync(victimDir, { recursive: true });
    writeText(path.join(victimDir, "keep.txt"), "keep");
    writeText(archivePath, "fixture pack contents");
    mockPackages([
      {
        packageName: "@evil/../../../../victim",
        version: "1.0.0",
        npmRoot,
        packArchivePath: archivePath,
      },
    ]);
    const result = await installPackArchive({ archivePath, mode: "update" });
    expectFailure(result, ERR.INVALID_NPM_SPEC, "unsupported npm pack package name");
    expectPresent(victimDir, "keep.txt");
    expectAbsent(path.join(npmRoot, "package.json"));
    expectAbsent(path.join(npmRoot, "_openclaw-pack-archives"));
    expect(runCommandMock.mock.calls).toHaveLength(1);
  });

  it.each(["rollback", "publication failure", "abort during consent"] as const)(
    "settles a same-generation project replacement with %s",
    async (settlement) => {
      const packageName = "same-generation-plugin";
      const install = (version: string) =>
        installNpm(`${packageName}@${version}`, { mode: "update" });
      let targetDir = "";
      for (const version of ["1.0.0", "2.0.0"]) {
        mockPackage({ spec: `${packageName}@${version}`, packageName, version, npmRoot });
        const installed = await install(version);
        assert(installed.ok, JSON.stringify(installed));
        targetDir = installed.targetDir;
      }
      const projectRoot = path.dirname(path.dirname(targetDir));
      const manifestPath = path.join(projectRoot, "package.json");
      const manifest = readManifest(projectRoot);
      manifest.overrides = { "existing-override": "1.0.0" };
      manifest.openclaw = {
        managedPeerDependencies: ["original-peer"],
        managedOverrides: ["existing-override"],
      };
      writeJson(manifestPath, manifest);
      writeText(path.join(projectRoot, "original.txt"), "original bytes");
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
      if (settlement !== "rollback") {
        if (settlement === "abort during consent") {
          expect(controller.signal.aborted).toBe(true);
          expect(updated.ok).toBe(false);
        } else {
          expect(refusedPublication).toBe(true);
          expect(updated).toMatchObject({
            ok: false,
            error: expect.stringContaining("publication refused"),
          });
        }
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
    const install = (version: string, mode?: "update") =>
      installNpm(`${packageName}@${version}`, { mode });
    mockPackages([
      codexPackage("2.0.0", {
        indexJs: `module.exports = {
  version: "v2",
  runAttempt: async () => (await import("./run-attempt-v2.js")).default,
};\n`,
        extraDistFiles: {
          "run-attempt-v2.js": "module.exports = { chunk: 'v2' };\n",
        },
      }),
    ]);
    const first = await install("2.0.0");
    assert(first.ok, JSON.stringify(first));
    const retainedModule = await import(
      pathToFileURL(path.join(first.targetDir, "dist", "index.js")).href
    );
    const retainedPackageDir = first.targetDir;
    mockPackages([
      codexPackage("3.0.0", {
        indexJs: "module.exports = { version: 'v3' };\n",
        replaceExisting: true,
      }),
    ]);
    const update = await install("3.0.0", "update");
    assert(update.ok, JSON.stringify(update));
    await markRetainedManagedNpmInstall({
      packageDir: retainedPackageDir,
      pluginId: "codex",
      reason: "test-rollback-retention",
    });
    mockPackages([
      codexPackage("2.0.0", {
        indexJs: "module.exports = { version: 'v2-rollback' };\n",
        replaceExisting: true,
      }),
    ]);
    const rollback = await install("2.0.0", "update");
    assert(rollback.ok, JSON.stringify(rollback));
    expect(rollback.targetDir).not.toBe(retainedPackageDir);
    await expect(retainedModule.default.runAttempt()).resolves.toEqual({ chunk: "v2" });
    expectPresent(retainedPackageDir, "dist", "run-attempt-v2.js");
  });

  it("keeps an active same-resolution artifact intact while an outer cohort owns publication", async () => {
    const packageName = "cohort-generation-plugin";
    let priorPackageDir = "";
    for (const version of ["1.0.0", "2.0.0"]) {
      mockPackage({ spec: `${packageName}@${version}`, packageName, version });
      const result = await installNpm(`${packageName}@${version}`, { mode: "update" });
      assert(result.ok, JSON.stringify(result));
      priorPackageDir = result.targetDir;
      await markRetainedManagedNpmInstall({
        packageDir: priorPackageDir,
        pluginId: packageName,
        reason: "test-updater-preimage",
      });
    }
    const priorProjectRoot = path.dirname(path.dirname(priorPackageDir));
    const priorBytes = readTextFileTree(priorProjectRoot);
    mockPackage({ spec: `${packageName}@2.0.0`, indexJs: "export const candidate = true;\n" });
    let preparedProjectRoot = "";
    let consentMode: string | undefined;
    const result = await installNpm(
      requestDeferredPluginInstall(
        {
          spec: `${packageName}@2.0.0`,
          mode: "update" as const,
          onBeforePluginArtifactCommit: async (artifact: PluginInstallArtifactConsentRequest) => {
            consentMode = artifact.mode;
          },
        },
        undefined,
        undefined,
        undefined,
        {
          forceFreshGeneration: true,
          beforeManagedNpmPublish: async (facts) => {
            expect(facts.pluginId).toBe(packageName);
            expect(readText(facts.stagedPackageDir, "dist", "index.js")).toContain("candidate");
            expect(readTextFileTree(priorProjectRoot)).toEqual(priorBytes);
            expectAbsent(facts.targetNpmRoot);
            preparedProjectRoot = facts.targetNpmRoot;
            writeText(
              path.join(facts.stagedNpmRoot, "cohort-intent.txt"),
              "prepared before publish",
            );
          },
        },
      ),
    );
    assert(result.ok, JSON.stringify(result));
    expect(consentMode).toBe("update");
    expect(result.targetDir).not.toBe(priorPackageDir);
    expect(readText(preparedProjectRoot, "cohort-intent.txt")).toBe("prepared before publish");
    expect(readTextFileTree(priorProjectRoot)).toEqual(priorBytes);
    const transaction = resolvePluginInstallTransaction(result);
    assert(transaction);
    await transaction.rollback();
    expectAbsent(preparedProjectRoot);
    expect(readTextFileTree(priorProjectRoot)).toEqual(priorBytes);
  });

  it("allocates a fresh generation when a plain install selects a retained artifact", async () => {
    const packageName = "@openclaw/codex";
    const legacyPackageDir = installedPackageDir(npmRoot, packageName);
    const fixture = codexPackage("2.0.0");
    const retainedGenerationPackageDir = path.join(
      resolvePluginNpmGenerationProjectDir({
        npmDir: npmRoot,
        packageName,
        generationKey: [
          packageName,
          fixture.version,
          fixture.spec,
          fixture.integrity,
          fixture.shasum,
        ].join("\n"),
      }),
      "node_modules",
      ...packageName.split("/"),
    );
    fs.mkdirSync(legacyPackageDir, { recursive: true });
    fs.mkdirSync(retainedGenerationPackageDir, { recursive: true });
    for (const packageDir of [legacyPackageDir, retainedGenerationPackageDir]) {
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "codex",
        reason: "test-retained-generation",
      });
    }
    mockPackages([fixture]);
    const result = await installNpm(fixture.spec);
    assert(result.ok, JSON.stringify(result));
    expect(result.targetDir).not.toBe(retainedGenerationPackageDir);
    expect(hasRetainedManagedNpmInstallMarker(result.targetDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(retainedGenerationPackageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(legacyPackageDir)).toBe(true);
  });

  const metadataFailures: Array<
    [
      label: string,
      fixture: Partial<MockNpmPackage>,
      errors: string[],
      attempts: number,
      expectedIntegrity?: string,
    ]
  > = [
    [
      "integrity drift",
      { integrity: "sha512-safe", installedIntegrity: "sha512-evil" },
      ["integrity sha512-evil", "expected sha512-safe"],
      1,
      "sha512-safe",
    ],
    ["version drift", { installedVersion: "1.0.1" }, ["version 1.0.1", "expected 1.0.0"], 1],
    [
      "missing integrity",
      { integrity: "sha512-safe", omitInstalledIntegrity: true },
      ["metadata remained incomplete after managed npm project recovery", "integrity missing"],
      2,
      "sha512-safe",
    ],
    [
      "missing lock entry",
      { skipLockfileEntry: true },
      ["npm install did not record package-lock metadata for metadata-plugin"],
      2,
    ],
  ];
  it.each(metadataFailures)(
    "rejects %s without publishing the plugin",
    async (_label, fixture, errors, attempts, expectedIntegrity) => {
      const packageName = "metadata-plugin";
      const npmProjectRoot = projectDir(packageName);
      mockPackage({
        spec: `${packageName}@latest`,
        expectedDependencySpec: "1.0.0",
        ...fixture,
      });
      const result = await installNpm({
        spec: `${packageName}@latest`,
        expectedIntegrity,
      });
      expectFailure(result, undefined, ...errors);
      expect(managedInstalls()).toHaveLength(attempts);
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
    const npmProjectRoot = projectDir(packageName);
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    writeText(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
    writeText(path.join(npmProjectRoot, "original.txt"), "original bytes");
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
    mockPackages([fixture, { packageName: addedPeerName, version: "2.0.0", npmRoot }]);
    let managedInstallAttempts = 0;
    let attemptedRoot = "";
    const warnings: string[] = [];
    const outsideDependencyDir = makeTempDir();
    interceptInstalls(async (root, next) => {
      if (packageName in (readManifest(root).dependencies ?? {})) {
        attemptedRoot = root;
        managedInstallAttempts += 1;
        if (managedInstallAttempts === 1) {
          const corruptPackage = path.join(attemptedRoot, "node_modules", "stale-plugin");
          fs.mkdirSync(corruptPackage, { recursive: true });
          writeText(path.join(corruptPackage, "stale.txt"), "poisoned stage");
        }
        if (managedInstallAttempts === 2) {
          fixture.omitInstalledIntegrity = false;
        }
      }
      const commandResult = await next();
      if (managedInstallAttempts === 2) {
        fs.symlinkSync(
          outsideDependencyDir,
          path.join(root, "node_modules", "outside-dependency"),
          "junction",
        );
      }
      return commandResult;
    });
    let mutatedPeerAfterQuarantine = false;
    const addPeerAfterQuarantine = () => {
      const manifestPath = path.join(attemptedRoot, "package.json");
      const manifest = readManifest(attemptedRoot);
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
    expectFailure(
      result,
      ERR.SECURITY_SCAN_FAILED,
      "installed dependency scan found package outside install root",
    );
    expect(managedInstallAttempts).toBe(2);
    expect(mutatedPeerAfterQuarantine).toBe(true);
    const quarantineDir = expectManagedNpmQuarantine(warnings);
    expect(readText(quarantineDir, "node_modules", "stale-plugin", "stale.txt")).toBe(
      "poisoned stage",
    );
    expect(readTextFileTree(npmProjectRoot)).toEqual(originalProject);
    expectAbsent(installedPackageDir(npmRoot, packageName));
  });

  it.each([true, false])(
    "settles current-platform package repair (repair succeeds: %s)",
    async (repair) => {
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
      const warnings: string[] = [];
      let attempts = 0;
      let repairCache = "";
      let removedIncomplete = false;
      interceptInstalls(async (root, next, env) => {
        const packageDir = path.join(root, ...platformPackageLocation.split("/"));
        if (repair && attempts === 1) {
          removedIncomplete = !fs.existsSync(packageDir);
        }
        const result = await next();
        attempts++;
        const lockfile = readLockfile(root);
        lockfile.packages ??= {};
        lockfile.packages[platformPackageLocation] = {
          name: platformPackage,
          version: "1.0.0-platform",
          optional: true,
          os: [process.platform],
          cpu: [process.arch],
        };
        writeJson(path.join(root, "package-lock.json"), lockfile);
        fs.rmSync(packageDir, { recursive: true, force: true });
        if (repair) {
          lockfile.packages["node_modules/@vendor/codex"] = { bin: { codex: "bin/codex.js" } };
          writeJson(path.join(root, "package-lock.json"), lockfile);
          fs.mkdirSync(packageDir, { recursive: true });
          writeJson(path.join(packageDir, "package.json"), {
            name: "@vendor/codex",
            version: "1.0.0-platform",
            files: ["vendor"],
          });
          const binDir = path.join(packageDir, "vendor", "current-platform", "bin");
          fs.mkdirSync(binDir, { recursive: true });
          if (attempts === 1) {
            writeText(path.join(binDir, "codex-helper"), "helper");
          } else {
            repairCache = env?.npm_config_cache ?? "";
            const executable = process.platform === "win32" ? "codex.exe" : "codex";
            fs.writeFileSync(path.join(binDir, executable), "native executable", {
              encoding: "utf8",
              mode: 0o755,
            });
          }
        }
        return result;
      });
      const result = await installNpm(
        `${packageName}@1.0.0`,
        repair ? { logger: warningLogger(warnings) } : {},
      );
      expect(attempts).toBe(2);
      if (repair) {
        expect({ ok: result.ok, removedIncomplete }).toEqual({ ok: true, removedIncomplete: true });
        expect(repairCache).toContain("openclaw-npm-cache-");
        expectAbsent(repairCache);
        expect(warnings).toContain(
          `npm left current-platform package(s) ${platformPackage} missing or incomplete; retrying once with a fresh cache.`,
        );
      } else {
        expectFailure(
          result,
          undefined,
          `npm install reported success but left required current-platform package(s) missing or incomplete: ${platformPackage}`,
        );
        expectAbsent(installedPackageDir(npmRoot, packageName));
      }
    },
  );

  it("keeps corrupt managed npm project artifacts quarantined when the rebuild retry fails", async () => {
    const packageName = "broken-plugin";
    const npmProjectRoot = projectDir(packageName);
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    writeText(path.join(npmProjectRoot, "original.txt"), "original bytes");
    const originalProject = readTextFileTree(npmProjectRoot);
    mockPackage({
      spec: `${packageName}@1.0.0`,
      expectedDependencySpec: "1.0.0",
    });
    let managedInstallAttempts = 0;
    interceptInstalls(async (root) => {
      managedInstallAttempts += 1;
      if (managedInstallAttempts === 1) {
        const stalePackageDir = path.join(root, "node_modules", "stale-plugin");
        fs.mkdirSync(stalePackageDir, { recursive: true });
        writeText(path.join(stalePackageDir, "stale.txt"), "corrupt stage");
        return failedSpawn(
          'npm ERR! code ERR_INVALID_ARG_TYPE\nnpm ERR! The "from" argument must be of type string. Received undefined',
        );
      }
      return failedSpawn("npm ERR! still broken");
    });
    const result = await installNpm(`${packageName}@1.0.0`);
    expectFailure(
      result,
      undefined,
      "npm install failed after managed npm project recovery",
      "Original npm error",
    );
    expect(managedInstallAttempts).toBe(2);
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
      logger: warningLogger(warnings),
    });
    expectFailure(result, undefined, "@openclaw/codex", "plugin-local node_modules/openclaw link");
    expect(
      warnings.some((warning) => warning.includes("Could not locate openclaw package root")),
    ).toBe(true);
    expectAbsent(installedPackageDir(npmRoot, "@openclaw/codex"));
    const npmProjectRoot = projectDir("@openclaw/codex");
    expectAbsent(path.join(npmProjectRoot, "package.json"));
  });

  it.each([false, true])(
    "rejects incompatible metadata (explicit prerelease: %s)",
    async (prerelease) => {
      const version = prerelease ? "2026.5.28-beta.4" : "2026.5.27";
      const host = prerelease ? "2026.5.28-beta.3" : "2026.5.10-beta.1";
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", host);
      const fixture = prerelease
        ? makePackage("@openclaw/msteams", version, {
            spec: "@openclaw/msteams@beta",
            pluginId: "msteams",
            versions: ["2026.5.27", version],
            openclaw: { extensions: ["./dist/index.js"], compat: { pluginApi: `>=${version}` } },
          })
        : whatsappPackage(version, version, { peerDependencies: { openclaw: `>=${version}` } });
      mockPackages([fixture]);
      const result = await installNpm(fixture.spec, prerelease ? { mode: "update" } : {});
      const guidance = prerelease
        ? []
        : [`runtime exposes ${host}`, "install a compatible plugin version"];
      expectFailure(
        result,
        ERR.INCOMPATIBLE_PLUGIN_API,
        `requires plugin API >=${version}`,
        ...guidance,
      );
      if (!prerelease) {
        expectAbsent(path.join(npmRoot, "node_modules", "@openclaw", "whatsapp"));
        expectAbsent(path.join(npmRoot, "package.json"));
      }
      expect(managedInstalls()).toHaveLength(0);
    },
  );

  it("preserves an existing npm plugin by resolving update metadata to a compatible version", async () => {
    const npmProjectRoot = projectDir("@openclaw/whatsapp");
    const warnings: string[] = [];
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    writeJson(path.join(npmProjectRoot, "package.json"), {
      private: true,
      dependencies: { "@openclaw/whatsapp": "2026.5.26" },
    });
    const compatible = whatsappPackage("2026.5.26", "2026.5.10-beta.1");
    writeInstalledNpmPlugin({ ...compatible, npmRoot: npmProjectRoot });
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.10-beta.1");
    mockPackages([
      whatsappPackage("2026.5.27", "2026.5.27", {
        spec: "@openclaw/whatsapp",
        versions: ["2026.5.26", "2026.5.27"],
      }),
      { ...compatible, expectedDependencySpec: "2026.5.26" },
    ]);
    const result = await installNpm({
      spec: "@openclaw/whatsapp",
      mode: "update",
      logger: warningLogger(warnings),
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
    expect(managedInstalls().length > 0).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "repairs root openclaw materialized by npm peer handling",
    async () => {
      mockPackage({
        spec: "required-peer-plugin@1.0.0",
        peerDependencies: { openclaw: "^2026.0.0" },
        materializesRootOpenClaw: true,
      });
      const result = await installNpm("required-peer-plugin@1.0.0");
      expect(result.ok).toBe(true);
      const npmProjectRoot = projectDir("required-peer-plugin");
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
    const npmProjectRoot = projectDir("@openclaw/discord");
    writeHostProject(npmProjectRoot, "2026.5.4", true);
    mockPackage({
      spec: "@openclaw/discord@beta",
      version: "2026.5.5-beta.1",
      pluginId: "discord",
      peerDependencies: { openclaw: ">=2026.5.5-beta.1" },
      expectedDependencySpec: "2026.5.5-beta.1",
    });
    const result = await installNpm("@openclaw/discord@beta");
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
    writeHostProject(npmRoot, "2026.5.12-beta.6");
    resolveOpenClawPackageRootSyncMock.mockReturnValue(hostPackageRoot);
    mockPackage({
      spec: "@xdarkicex/openclaw-memory-libravdb@1.4.69",
      version: "1.4.69",
      pluginId: "libravdb-memory",
      expectedDependencySpec: "1.4.69",
    });
    const result = await installNpm("@xdarkicex/openclaw-memory-libravdb@1.4.69");
    assert(result.ok, JSON.stringify(result));
    const baseManifest = readManifest(npmRoot);
    expect(baseManifest.dependencies?.openclaw).toBe("2026.5.12-beta.6");
    expect(baseManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBeUndefined();
    const npmProjectRoot = projectDir("@xdarkicex/openclaw-memory-libravdb");
    const projectManifest = readManifest(npmProjectRoot);
    expect(projectManifest.dependencies?.["@xdarkicex/openclaw-memory-libravdb"]).toBe("1.4.69");
    expectPresent(hostPackageRoot);
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
    writeText(archivePath, "fixture archive");
    const npmProjectRoot = projectDir(packageName);
    writeInstalledNpmPlugin({
      npmRoot: npmProjectRoot,
      packageName: "existing-package",
      version: "1.0.0",
    });
    writeText(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
    writeText(path.join(npmProjectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
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
    expectPresent(installedPackageDir(npmRoot, packageName));
  });

  it("preserves an empty managed project after refused npm-pack relocation and permits retry", async () => {
    const stateDir = makeTempDir();
    const packageName = "relocation-fixture";
    const spec = `${packageName}@1.0.0`;
    const archivePath = path.join(stateDir, "plugin.tgz");
    writeText(archivePath, "fixture archive");
    const npmProjectRoot = projectDir(packageName);
    fs.mkdirSync(npmProjectRoot, { recursive: true });
    mockPackages([{ spec, packArchivePath: archivePath, packageName, version: "1.0.0", npmRoot }]);
    const refused = new Error("artifact consent refused");
    const onBeforePluginArtifactCommit = vi.fn(async () => {});
    onBeforePluginArtifactCommit.mockRejectedValueOnce(refused);
    const install = () => {
      const params = { mode: "update" as const, onBeforePluginArtifactCommit };
      return installPackArchive({ ...params, archivePath });
    };
    await expect(install()).rejects.toBe(refused);
    expectPresent(npmProjectRoot);
    expect(fs.readdirSync(npmProjectRoot)).toEqual([]);
    const retry = await install();
    expect(retry).toMatchObject({ ok: true, pluginId: packageName });
    expectPresent(installedPackageDir(npmRoot, packageName), "dist", "index.js");
  });

  it("preserves host peer links across a staged npm update ending in failure", async () => {
    const packageName = "@openclaw/peer-fixture";
    const fixture = (version: string) => ({
      spec: `${packageName}@${version}`,
      packageName,
      pluginId: "peer-fixture",
      version,
      npmRoot,
      peerDependencies: { openclaw: "*" },
    });
    mockPackage(fixture("1.0.0"));
    const first = await installNpm(`${packageName}@1.0.0`);
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
    writeText(
      path.join(hostRoot, "pnpm-workspace.yaml"),
      `overrides:
  axios: 1.18.0
  node-domexception: "npm:@nolyfill/domexception@1.0.28"
  "range-target@>1": 2.0.0
  "werift-ice@0.2.2>ip": "npm:neoip@3.1.0"
  nested:
    alias: "npm:@scope/alias@1.0.0"
    semver: 1.2.3
`,
    );
    const compatible = { axios: "1.18.0", nested: { semver: "1.2.3" }, "range-target@>1": "2.0.0" };
    const aliases = {
      ...compatible,
      nested: { ...compatible.nested, alias: "npm:@scope/alias@1.0.0" },
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    };
    mockPackage({ spec: "@openclaw/voice-call@0.0.1", version: "0.0.1", pluginId: "voice-call" });
    const delegate = npmDelegate();
    let attempts = 0;
    runCommandMock.mockImplementation(async (argv: string[], options?: { cwd?: string }) => {
      if (isNpmPeerPlannerInstallCommand(argv)) {
        const manifest = readManifest(options?.cwd ?? "");
        expect(manifest.overrides).not.toHaveProperty("werift-ice@0.2.2>ip");
        expect(manifest.overrides?.["range-target@>1"]).toBe("2.0.0");
      }
      if (isManagedNpmInstallCommand(argv)) {
        attempts++;
        if (!options?.cwd) {
          throw new Error("expected npm install cwd");
        }
        const manifest = readManifest(options.cwd);
        const expected = attempts === 1 ? aliases : compatible;
        expect(manifest.overrides).toEqual(expected);
        expect(manifest.openclaw?.managedOverrides).toEqual(Object.keys(expected).toSorted());
        if (attempts === 1) {
          return failedSpawn("npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28");
        }
      }
      return delegate(argv, options);
    });
    const warnings: string[] = [];
    const result = await installNpm("@openclaw/voice-call@0.0.1", {
      logger: warningLogger(warnings),
    });
    expect({ ok: result.ok, attempts }).toEqual({ ok: true, attempts: 2 });
    expect(warnings).toEqual([
      "npm rejected managed npm overrides; retrying plugin install without npm-incompatible overrides for this npm version.",
    ]);
  });

  it("rejects a trusted official npm plugin with a malformed manifest", async () => {
    const packageName = "@openclaw/official-malformed";
    const expectedPluginId = "official-malformed";
    const npmProjectRoot = projectDir(packageName);
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
    expectFailure(
      result,
      ERR.MISSING_PLUGIN_MANIFEST,
      "package missing valid openclaw.plugin.json",
    );
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
    mockPackage({ spec: packageName, nativeManifest: "missing" });
    const result = await installNpm(packageName, {
      expectedPluginId: "legacy-plugin",
      trustedSourceLinkedOfficialInstall: false,
      mode: "update",
    });
    expect(result).toMatchObject({ ok: true, pluginId: packageName });
    expectPresent(installedPackageDir(npmRoot, packageName));
  });

  it.each([false, true])(
    "accepts a trusted id replacement (catalog lookup: %s)",
    async (catalog) => {
      const replacementId = catalog ? "openclaw-qqbot" : "fish-audio-speech";
      const fixture = catalog
        ? makePackage("@tencent-connect/openclaw-qqbot", "2.0.3", { pluginId: replacementId })
        : fishPackage();
      const result = await installReplacement({
        fixture,
        expectedId: catalog ? "qqbot" : "fish-audio",
        replacementId,
      });
      expect(result).toMatchObject({ ok: true, pluginId: replacementId });
    },
  );

  it.each([
    "untrusted source",
    "different catalog replacement",
    "fresh install",
    "manifest without the legacy id",
  ])("rejects a manifest id replacement for a %s", async (scenario) => {
    const options: Replacement = {
      trusted: scenario !== "untrusted source",
      mode: scenario === "fresh install" ? "install" : "update",
      replacementId:
        scenario === "different catalog replacement" ? "different-plugin" : "fish-audio-speech",
      fixture: fishPackage({
        legacyPluginIds: scenario === "manifest without the legacy id" ? undefined : ["fish-audio"],
      }),
    };
    expect(await installReplacement(options)).toMatchObject({
      ok: false,
      code: ERR.PLUGIN_ID_MISMATCH,
    });
  });

  it("rejects non-registry npm specs", async () => {
    const result = await installNpm("github:evil/evil");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported npm spec"),
      code: ERR.INVALID_NPM_SPEC,
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
    const result = await installNpm({ spec: "@openclaw/voice-call@0.0.1", mode: "install" });
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
    const result = await installNpm("@openclaw/not-found");
    expect(result).toMatchObject({ ok: false, code: ERR.NPM_PACKAGE_NOT_FOUND });
  });

  it("rejects implicit prerelease npm specs with beta guidance", async () => {
    mockNpmViewMetadataResult(runCommandMock, {
      name: "@openclaw/voice-call",
      version: "0.0.2-beta.1",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });
    const rejected = await installNpm("@openclaw/voice-call");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("prerelease version 0.0.2-beta.1");
      expect(rejected.error).toContain('"npm:@openclaw/voice-call@beta"');
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
