import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type * as GatewayEntrypoints from "../daemon/gateway-entrypoint.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { createStatfsFixture } from "../infra/disk-space.test-support.js";
import { gitReleaseSlot, resolveGitReleasePrefix } from "../infra/git-release-paths.js";
import { isBetaTag } from "../infra/update-channels.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import { writeFixtureJsonSync } from "./cli-fixtures.test-support.js";
import * as assert from "./update-cli-assertions.test-support.js";
import { registerUpdateCliLifecycle } from "./update-cli-lifecycle.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { withPostCoreUpdateFixtureRun } from "./update-cli-shared-fixture.test-support.js";
import * as configs from "./update-cli/update-cli-config.test-support.js";
import * as packages from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

export function createUpdateCliFixture(fixtureOptions: { databaseEngines?: string[] } = {}) {
  const targetDeclaration = fixtureOptions.databaseEngines
    ? { databaseEngines: fixtureOptions.databaseEngines }
    : {};
  // Unique across concurrent runs; realpath normalizes macOS's /var symlink.
  const fixtureRoot = fsSync.realpathSync(
    fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-tests-")),
  );
  const checkoutRoot = path.join(fixtureRoot, "checkout");
  fsSync.mkdirSync(checkoutRoot);
  for (const directory of [".git", "src", "extensions"]) {
    fsSync.mkdirSync(path.join(checkoutRoot, directory));
  }
  writeFixtureJsonSync(path.join(checkoutRoot, "package.json"), {
    name: "openclaw",
    version: VERSION,
    ...(fixtureOptions.databaseEngines ? { openclaw: targetDeclaration } : {}),
  });
  const globalNpmConfig = path.join(fixtureRoot, "global-npmrc");
  fsSync.writeFileSync(globalNpmConfig, "");

  let fixtureCount = 0;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const tempDirsToCleanup = new Set<string>();

  // Real-I/O callers create the directory; others only need a stable path.
  const createCaseDir = (prefix: string) => path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);

  const { initializeExistingUpdateProfile } = update;

  const baseConfig: OpenClawConfig = {};
  const baseSnapshot = configs.createUpdateCliBaseSnapshot(baseConfig);

  const setStreamTty = (
    stream: NodeJS.ReadStream | NodeJS.WriteStream,
    value: boolean | undefined,
  ) => {
    Object.defineProperty(stream, "isTTY", { value, configurable: true });
  };
  const setTty = (value: boolean | undefined) => setStreamTty(process.stdin, value);

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(update.resolveUpdateInstallKind).mockResolvedValue("package");
    vi.mocked(update.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "package" });
    vi.mocked(update.checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: { manager: "npm", status: "ok", lockfilePath: null, markerPath: null },
    });
  };

  const mockPackageInstallAtCaseDir = async (prefix = "openclaw-update", version = "1.0.0") => {
    const { pkgRoot, nodeModules } = await setupInstalledPackageRoot(
      createCaseDir(prefix),
      version,
    );
    // The global prefix owns bin even when no launchers are published.
    await fs.mkdir(path.join(path.dirname(path.dirname(nodeModules)), "bin"), {
      recursive: true,
    });
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i") {
        await packages.writeNpmPackageInstall(argv, pkgRoot);
      }
    });
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    return pkgRoot;
  };

  const primeNpmChannelTag = (tag: string, version: string | null): void => {
    vi.mocked(update.resolveNpmChannelTag).mockResolvedValue({ tag, version });
  };

  const primeServiceCommand = (
    programArguments: Array<string | undefined>,
    environment?: NodeJS.ProcessEnv,
    sourcePath?: string,
  ): void => {
    const managedDefinition = {
      programArguments,
      ...(environment === undefined ? {} : { environment }),
    };
    mocks.serviceReadCommand.mockResolvedValue({
      ...managedDefinition,
      managedDefinition,
      ...(sourcePath ? { sourcePath } : {}),
    });
  };

  const mockOwnedGitService = (root = process.cwd()) => {
    const serviceEntrypoint = path.join(root, "dist", "index.js");
    primeServiceCommand(
      ["node", serviceEntrypoint, "gateway", "run"],
      undefined,
      process.platform === "win32" ? resolveGatewayTaskScriptPath(process.env) : undefined,
    );
    mocks.pathExists.mockImplementation(async (candidate: string) => {
      if (candidate === path.join(root, "package.json") || candidate === serviceEntrypoint) {
        return true;
      }
      return await fs.access(candidate).then(
        () => true,
        () => false,
      );
    });
  };

  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";

  const mockCurrentProcessFreshDoctor = packages.createCurrentProcessFreshDoctorFixture(
    update.resolveGatewayInstallEntrypoint,
    FRESH_POST_UPDATE_ENTRYPOINT,
  );

  const configFixtures = configs.createUpdateCliConfigFixtures({
    baseConfig,
    baseSnapshot,
    readConfigFileSnapshot: update.readConfigFileSnapshot,
    syncPluginsForUpdateChannel: mocks.syncPluginsForUpdateChannel,
    updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
    createCaseDir,
  });

  const runPostCoreCommand = (
    options: Parameters<typeof update.updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      () => withPostCoreUpdateFixtureRun(() => update.updateCommand(options)),
    );

  const mockGatewayHealth = (version: string, connId: string, buildId?: string) => {
    mocks.callGateway.mockImplementation(
      gatewayHealthResponse({ server: { version, connId, buildId, bootId: "test-gateway-boot" } }),
    );
  };

  const packageFixtures = packages.createUpdateCliPackageFixtures({
    runCommandWithTimeout: update.runCommandWithTimeout,
    serviceStop: mocks.serviceStop,
    serviceReadRuntime: mocks.serviceReadRuntime,
    serviceReadCommand: mocks.serviceReadCommand,
    serviceLoaded: mocks.serviceLoaded,
    pathExists: mocks.pathExists,
    gatewayFixturePid: mocks.gatewayFixturePid,
    sqliteHostPlatform: mocks.sqliteHostPlatform,
    mockGatewayHealth,
    mockPackageInstallStatus,
  });
  const {
    mockNpmGlobalCommands,
    mockFileBackedPathExists,
    setupInstalledPackageRoot,
    mockGatewayInstallFailure: configureGatewayInstallFailure,
  } = packageFixtures;
  const mockGatewayInstallFailure = (entrypoint: string, stderr?: string) => {
    const runPrevious = assert.requireValue(
      vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
      "package command fixture",
    );
    configureGatewayInstallFailure(entrypoint, stderr);
    const runFailure = assert.requireValue(
      vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
      "gateway install failure fixture",
    );
    vi.mocked(update.runCommandWithTimeout).mockImplementation((argv, options) =>
      argv[1] === entrypoint && argv[2] === "gateway" && argv[3] === "install"
        ? runFailure(argv, options)
        : runPrevious(argv, options),
    );
  };

  const fixture = {
    ...configFixtures,
    ...packageFixtures,
    baseConfig,
    baseSnapshot,
    completeChangedPostCorePluginUpdate: (
      overrides: Partial<Parameters<typeof update.completePostCorePluginUpdate>[0]> = {},
    ) => update.completePostCorePluginUpdate(configs.createChangedPostCoreUpdateOptions(overrides)),
    createCaseDir,
    /** The completion child runs only when the installed launcher exists. */
    mockCompletionCacheRefresh: (result: Parameters<typeof createCommandResult>[0]) => {
      const pathExists = mocks.pathExists.getMockImplementation();
      mocks.pathExists.mockImplementation(
        async (candidate: string) =>
          candidate.endsWith("openclaw.mjs") || Boolean(await pathExists?.(candidate)),
      );
      const run = assert.requireValue(
        vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
        "command fixture",
      );
      vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) =>
        argv[2] === "completion" ? createCommandResult(result) : run(argv, options),
      );
    },
    expectFailedManagedGitRestart: (message: string) => {
      const logs = assert.getLogOutput();
      expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
      expect(assert.freshRestartCalls()).toHaveLength(1);
      expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
      expect(
        [logs, ...vi.mocked(update.defaultRuntime.error).mock.calls.flat()].join("\n"),
      ).toContain(message);
      expect(logs).not.toContain("Gateway: restarted and verified.");
      expect(logs).not.toContain("Update Result: OK");
    },
    expectFreshPostUpdateDoctor: (params: { yes: boolean; workspaceSuggestions?: boolean }) => {
      const calls = vi
        .mocked(update.runExec)
        .mock.calls.filter(
          ([, args]) => args[0] === FRESH_POST_UPDATE_ENTRYPOINT && args[1] === "doctor",
        );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual([
        FRESH_POST_UPDATE_ENTRYPOINT,
        "doctor",
        "--repair",
        "--non-interactive",
        ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
        ...(params.yes ? ["--yes"] : []),
      ]);
    },
    fixtureRoot,
    FRESH_POST_UPDATE_ENTRYPOINT,
    globalNpmConfig,
    initializeExistingUpdateProfile,
    mockCurrentProcessFreshDoctor,
    mockGatewayHealth,
    mockGatewayInstallFailure,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir: (profile = "default") =>
      path.join(
        expectDefined(process.env.HOME, "isolated test home"),
        profile === "default" ? ".openclaw" : `.openclaw-${profile}`,
      ),
    runControlPlaneUpdate: async (params: {
      meta: Record<string, unknown>;
      options: Parameters<typeof update.updateCommand>[0];
      beforeUpdate?: () => void | Promise<void>;
      expectedExitCode?: number;
    }) => {
      const home = tempDirs.make("openclaw-update-sentinel-home-");
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(stateDir);
      const metaDir = tempDirs.make("openclaw-update-sentinel-meta-");
      const metaPath = path.join(metaDir, "meta.json");
      await packages.writeJsonFixture(metaPath, { version: 1, meta: params.meta }, false);
      await params.beforeUpdate?.();
      await withEnvAsync(
        {
          [update.CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          initializeExistingUpdateProfile();
          if (params.expectedExitCode === undefined) {
            await update.invokeUpdateCli(params.options);
          } else {
            await expect(update.invokeUpdateCli(params.options)).rejects.toEqual(
              new update.ExitError(params.expectedExitCode),
            );
          }
        },
      );
      return update.readRestartSentinel({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
    },
    runPostCoreCommand,
    runPostCoreUpdate: (env: NodeJS.ProcessEnv = {}) =>
      runPostCoreCommand({ yes: true, restart: false }, env),
    runRestartFallbackScenario: async (params: { daemonInstall: "ok" | "fail" }) => {
      const previousRoot = createCaseDir("openclaw-git-service");
      await packages.writeOpenClawPackageFixture(previousRoot, "1.0.0", {
        git: true,
        builtSha: "b".repeat(40),
        entrySource: "export {};\n",
      });
      vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(previousRoot);
      mockOwnedGitService(previousRoot);
      const entrypoint = path.join(gitReleaseSlot(resolveGitReleasePrefix()), "dist", "index.js");
      update.mockGitUpdateAfterMutation(
        update.makeOkUpdateResult({ root: previousRoot, after: { version: VERSION } }),
        { databaseEngines: ["sqlite", "postgres"] },
      );
      mockFileBackedPathExists();
      vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      const runPrevious = assert.requireValue(
        vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
        "updated Git command fixture",
      );
      vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) => {
        const result = await runPrevious(argv, options);
        if (argv[1] === entrypoint && argv[2] === "gateway" && result.code === 0) {
          if (argv[3] === "install") {
            primeServiceCommand([argv[0], entrypoint, "gateway", "run"]);
          }
          if (argv[3] === "restart") {
            mockGatewayHealth(VERSION, "updated-gateway", "fixture-original-build");
          }
        }
        return result;
      });
      if (params.daemonInstall === "fail") {
        mockGatewayInstallFailure(entrypoint);
      }
      mocks.serviceLoaded.mockResolvedValue(true);
      mockGatewayHealth("1.0.0", "previous-gateway", "fixture-original-build");

      await update.updateCommand({}).catch((cause: unknown) => {
        throw new Error(`${assert.getLogOutput()}\n${assert.getErrorOutput()}`, { cause });
      });

      expect(assert.gatewayCommandCall(entrypoint, "install")).toBeDefined();
      expect(assert.freshRestartCalls()).toHaveLength(params.daemonInstall === "ok" ? 1 : 0);
    },
    runWithGatewayServiceEnv: (
      options: Parameters<typeof update.updateCommand>[0],
      env: NodeJS.ProcessEnv = {},
    ) =>
      withEnvAsync(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          ...env,
        },
        () => update.invokeUpdateCli(options),
      ),
    setStdoutTty: (value: boolean | undefined) => setStreamTty(process.stdout, value),
    setTty,
    setupNonInteractiveDowngrade: async () => {
      const tempDir = await mockPackageInstallAtCaseDir();
      setTty(false);
      mocks.readPackageVersion.mockResolvedValue("2.0.0");
      primeNpmChannelTag(isBetaTag(VERSION) ? "beta" : "latest", "0.0.1");
      vi.mocked(update.defaultRuntime.error).mockClear();
      vi.mocked(update.defaultRuntime.exit).mockClear();

      return tempDir;
    },
    setupNpmUpdatedRootRefresh: async () => {
      const targetVersion = "2026.4.24";
      const updatedRoot = await mockPackageInstallAtCaseDir(
        "openclaw-updated-package",
        "2026.4.23",
      );
      const updatedEntrypoint = path.join(updatedRoot, "dist", "index.js");
      primeNpmChannelTag("latest", targetVersion);
      mockFileBackedPathExists();
      const entrypoints = await vi.importActual<typeof GatewayEntrypoints>(
        "../daemon/gateway-entrypoint.js",
      );
      vi.mocked(update.resolveGatewayInstallEntrypoint)
        .mockReset()
        .mockImplementation(entrypoints.resolveGatewayInstallEntrypoint);
      mocks.readPackageVersion.mockImplementation(async (packageRoot: string) => {
        try {
          const manifest = JSON.parse(
            await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ) as { version: string };
          return manifest.version;
        } catch {
          return null;
        }
      });
      mockGatewayHealth(targetVersion, "updated-gateway");
      mocks.serviceLoaded.mockResolvedValue(true);
      primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
      return { updatedRoot, updatedEntrypoint };
    },
    statfsFixture: createStatfsFixture,
    tempDirs,
    tempDirsToCleanup,
    useNativeScheduledTaskControl: async () => {
      const nativeTaskControl = await vi.importActual<
        typeof import("../daemon/schtasks-control.js")
      >("../daemon/schtasks-control.js");
      for (const method of [
        "suspendScheduledTaskAutoStartForUpdate",
        "resumeScheduledTaskAutoStartAfterUpdate",
      ] as const) {
        mocks[method].mockImplementation(nativeTaskControl[method]);
      }
    },
  };
  registerUpdateCliLifecycle(fixture);
  return fixture;
}
