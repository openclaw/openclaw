import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { isBetaTag } from "../infra/update-channels.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  freshRestartCalls,
  gatewayCommandCall,
  getLogOutput,
  requireValue,
  type UpdateCliScenario,
} from "./update-cli-assertions.test-support.js";
import { registerUpdateCliLifecycle } from "./update-cli-lifecycle.test-support.js";
import {
  callGateway,
  gatewayFixturePid,
  pathExists,
  readPackageVersion,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceStop,
  sqliteHostPlatform,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  checkUpdateStatus,
  completePostCorePluginUpdate,
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  createUpdateStateProfileInitializer,
  defaultRuntime,
  ExitError,
  invokeUpdateCli,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  readRestartSentinel,
  resolveGatewayInstallEntrypoint,
  resolveNpmChannelTag,
  resolveOpenClawPackageRoot,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runExec,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  createChangedPostCoreUpdateOptions,
  createUpdateCliBaseSnapshot,
  createUpdateCliConfigFixtures,
} from "./update-cli/update-cli-config.test-support.js";
import {
  createCurrentProcessFreshDoctorFixture,
  createUpdateCliPackageFixtures,
  writeJsonFixture,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

export function createUpdateCliFixture() {
  // Per-run unique root: concurrent runs on one machine (CI shards, sibling checkouts) must
  // never share fixture paths — some cases write real files and rm them in cleanup. Realpath'd
  // because macOS os.tmpdir() is a /var -> /private/var symlink.
  const fixtureRoot = fsSync.realpathSync(
    fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-tests-")),
  );
  const globalNpmConfig = path.join(fixtureRoot, "global-npmrc");
  fsSync.writeFileSync(globalNpmConfig, "");
  const profileStateDir = (profile = "default") =>
    path.join(
      expectDefined(process.env.HOME, "isolated test home"),
      profile === "default" ? ".openclaw" : `.openclaw-${profile}`,
    );
  let fixtureCount = 0;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const tempDirsToCleanup = new Set<string>();
  const fixtureStateDatabases = new Set<string>();

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Callers that only need a stable path skip creating it; real-I/O callers mkdir themselves.
    return dir;
  };

  const initializeExistingUpdateProfile = createUpdateStateProfileInitializer(
    fixtureRoot,
    fixtureStateDatabases,
  );

  const baseConfig: OpenClawConfig = {};
  const baseSnapshot = createUpdateCliBaseSnapshot(baseConfig);

  const clawHubRiskWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSuspiciousPayloadWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "│ Overview: Review the requested capabilities.             │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSyncRiskError =
    "Failed to update demo: ClawHub blocked this release; update was not started. (ClawHub clawhub:demo@1.2.4).";

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(resolveUpdateInstallKind).mockResolvedValue("package");
    vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "package" });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: null,
        markerPath: null,
      },
    });
  };

  const mockPackageInstallAtCaseDir = async (prefix = "openclaw-update", version = "1.0.0") => {
    const { pkgRoot, nodeModules } = await setupInstalledPackageRoot(
      createCaseDir(prefix),
      version,
    );
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot);
      }
    });
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    return pkgRoot;
  };

  const primeNpmChannelTag = (tag: string, version: string | null): void => {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag, version });
  };

  const primeServiceCommand = (
    programArguments: Array<string | undefined>,
    environment?: NodeJS.ProcessEnv,
  ): void => {
    const managedDefinition = {
      programArguments,
      ...(environment === undefined ? {} : { environment }),
    };
    serviceReadCommand.mockResolvedValue({
      ...managedDefinition,
      managedDefinition,
    });
  };

  const statfsFixture = (params: {
    bavail: number;
    bsize?: number;
    blocks?: number;
  }): ReturnType<typeof fsSync.statfsSync> => ({
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    frsize: params.bsize ?? 1024,
    ffree: 0,
  });

  const reportCandidateSteps = <T extends { steps: UpdateRunResult["steps"] }>(
    options: { onStep?: (step: UpdateRunResult["steps"][number]) => void },
    result: T,
  ): T => {
    for (const step of result.steps) {
      options.onStep?.(step);
    }
    return result;
  };

  const mockOwnedGitService = (root = process.cwd()) => {
    const serviceEntrypoint = path.join(root, "dist", "index.js");
    primeServiceCommand(["node", serviceEntrypoint, "gateway", "run"]);
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(root, "package.json") || candidate === serviceEntrypoint,
    );
  };

  const useNativeScheduledTaskControl = async () => {
    const nativeTaskControl = await vi.importActual<typeof import("../daemon/schtasks-control.js")>(
      "../daemon/schtasks-control.js",
    );
    suspendScheduledTaskAutoStartForUpdate.mockImplementation(
      nativeTaskControl.suspendScheduledTaskAutoStartForUpdate,
    );
    resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
      nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
    );
  };

  const runUpdateCliScenario = async (testCase: UpdateCliScenario) => {
    vi.clearAllMocks();
    await testCase.run();
    testCase.assert();
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    mockOwnedGitService();
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    if (params.daemonInstall === "fail") {
      mockGatewayInstallFailure(entrypoint);
    }
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(gatewayCommandCall(entrypoint, "install")).toBeDefined();
    expect(freshRestartCalls()).toHaveLength(1);
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = await mockPackageInstallAtCaseDir();
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");
    primeNpmChannelTag(isBetaTag(VERSION) ? "beta" : "latest", "0.0.1");
    vi.mocked(updateGitCheckout).mockResolvedValue(makeOkUpdateResult({ mode: "npm" }));
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: (root: string) => Promise<UpdateRunResult>;
    entrypoints?: string[];
    admitMutation?: boolean;
    targetVersion?: string;
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const targetVersion = params?.targetVersion ?? VERSION;
    const entrypoints = params?.entrypoints ?? [path.join(root, "dist", "entry.js")];
    const packageRoots = entrypoints.map((entrypoint) => path.dirname(path.dirname(entrypoint)));
    const packageJsonPaths = new Set(
      packageRoots.map((packageRoot) => path.join(packageRoot, "package.json")),
    );
    for (const entrypoint of entrypoints) {
      const packageRoot = path.dirname(path.dirname(entrypoint));
      const packageJsonPath = path.join(packageRoot, "package.json");
      fsSync.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fsSync.writeFileSync(entrypoint, "// test entrypoint\n", "utf8");
      fsSync.writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "openclaw", version: targetVersion }),
        "utf8",
      );
      tempDirsToCleanup.add(packageRoot);
    }
    pathExists.mockImplementation(
      async (candidate: string) =>
        packageJsonPaths.has(candidate) || entrypoints.includes(candidate),
    );
    const readPreviousPackageVersion = requireValue(
      readPackageVersion.getMockImplementation(),
      "package version fixture",
    );
    readPackageVersion.mockImplementation(async (packageRoot: string) =>
      packageRoots.includes(packageRoot) ? targetVersion : readPreviousPackageVersion(packageRoot),
    );
    vi.mocked(updateGitCheckout).mockImplementation(async ({ opts: options }) => {
      // The real Git runner admits its original owner even without activation.
      // Finalization-only fixtures retain that read/prepare callback, not a fake fence.
      await options.inspectGitTarget({});
      // Baseline-capture cases separately exercise the actual mutation callback.
      if (params?.admitMutation) {
        await requireValue(options.beforeGitMutation, "Git mutation admission")({});
      }
      return params?.gatewayUpdateImpl
        ? params.gatewayUpdateImpl(root)
        : makeOkUpdateResult({ mode: "npm", root, after: { version: targetVersion } });
    });
    mockGatewayHealth(targetVersion, "updated-gateway");
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", entrypoints[0], "gateway", "run"]);
    return { root, entrypoints };
  };

  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";

  const mockCurrentProcessFreshDoctor = createCurrentProcessFreshDoctorFixture(
    resolveGatewayInstallEntrypoint,
    FRESH_POST_UPDATE_ENTRYPOINT,
  );

  const expectFreshPostUpdateDoctor = (params: {
    yes: boolean;
    workspaceSuggestions?: boolean;
  }) => {
    const calls = vi
      .mocked(runExec)
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
  };

  const {
    mockNpmPluginOutcomes,
    mockNoopPostUpdatePluginConvergence,
    mockPostDoctorSnapshot,
    configSnapshot,
    useFileBackedConfig,
    setupPostCoreConfigFixture,
  } = createUpdateCliConfigFixtures({
    baseConfig,
    baseSnapshot,
    readConfigFileSnapshot,
    syncPluginsForUpdateChannel,
    updateNpmInstalledPlugins,
    createCaseDir,
  });

  const runPostCoreUpdate = (env: NodeJS.ProcessEnv = {}) => {
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      async () => {
        await updateCommand({ yes: true, restart: false });
      },
    );
  };

  const runPostCoreCommand = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) => {
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      async () => {
        await updateCommand(options);
      },
    );
  };

  const expectFailedManagedGitRestart = (message: string) => {
    const logs = getLogOutput();
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(freshRestartCalls()).toHaveLength(1);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect([logs, ...vi.mocked(defaultRuntime.error).mock.calls.flat()].join("\n")).toContain(
      message,
    );
    expect(logs).not.toContain("Gateway: restarted and verified.");
    expect(logs).not.toContain("Update Result: OK");
  };

  const mockGatewayHealth = (version: string, connId: string, buildId?: string) => {
    callGateway.mockImplementation(
      gatewayHealthResponse({ server: { version, connId, buildId, bootId: "test-gateway-boot" } }),
    );
  };

  const {
    mockNpmGlobalCommands,
    mockFileBackedPathExists,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    setupServicePackageAtPrefix,
    mockPackageGatewayLifecycle,
    mockServicePackageCommands,
    mockRunningManagedGateway,
    mockStoppedManagedGitGateway,
    mockNpmGlobalRoot,
    mockPackageReplacementFailure,
    mockGatewayInstallFailure,
  } = createUpdateCliPackageFixtures({
    runCommandWithTimeout,
    serviceStop,
    serviceReadRuntime,
    serviceReadCommand,
    serviceLoaded,
    pathExists,
    gatewayFixturePid,
    sqliteHostPlatform,
    mockGatewayHealth,
    mockPackageInstallStatus,
  });

  const completeChangedPostCorePluginUpdate = (
    overrides: Partial<Parameters<typeof completePostCorePluginUpdate>[0]> = {},
  ) => completePostCorePluginUpdate(createChangedPostCoreUpdateOptions(overrides));

  const setupNpmUpdatedRootRefresh = () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    return { updatedRoot, updatedEntrypoint };
  };

  const setupManagedGitRootRefresh = async (reinspect = false) => {
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const updatedEntrypoint = requireValue(entrypoints[0], "updated entrypoint");
    await writeOpenClawPackageFixture(root, VERSION, { entryPath: updatedEntrypoint });
    mockOwnedGitService();
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-managed-sha", version: "2026.4.26" },
        after: { sha: "new-managed-sha", version: VERSION },
      }),
      reinspect,
    );
    mockFileBackedPathExists();
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    serviceStop.mockImplementationOnce(async () => {
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    });
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await runFixtureCommand(argv, options);
      if (argv[2] === "gateway" && argv[3] === "install" && result.code === 0) {
        expect(argv[1]).toBe(updatedEntrypoint);
        const env = requireValue(
          typeof options === "number" ? undefined : options.env,
          "gateway install environment",
        );
        primeServiceCommand([argv[0], updatedEntrypoint, "gateway", "run"], env);
      }
      if (argv[2] === "gateway" && argv[3] === "restart" && result.code === 0) {
        expect(argv[1]).toBe(updatedEntrypoint);
        serviceReadRuntime.mockResolvedValue({
          status: "running",
          pid: gatewayFixturePid,
          state: "running",
        });
        mockGatewayHealth(VERSION, "updated-work");
      }
      return result;
    });
    return updatedEntrypoint;
  };

  const runWithGatewayServiceEnv = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        ...env,
      },
      async () => {
        await invokeUpdateCli(options);
      },
    );

  const runControlPlaneUpdate = async (params: {
    meta: Record<string, unknown>;
    options: Parameters<typeof updateCommand>[0];
    beforeUpdate?: () => void | Promise<void>;
    expectedExitCode?: number;
  }) => {
    const home = tempDirs.make("openclaw-update-sentinel-home-");
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir);
    const metaDir = tempDirs.make("openclaw-update-sentinel-meta-");
    const metaPath = path.join(metaDir, "meta.json");
    await writeJsonFixture(metaPath, { version: 1, meta: params.meta }, false);
    await params.beforeUpdate?.();
    await withEnvAsync(
      {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        initializeExistingUpdateProfile();
        if (params.expectedExitCode === undefined) {
          await invokeUpdateCli(params.options);
        } else {
          await expect(invokeUpdateCli(params.options)).rejects.toEqual(
            new ExitError(params.expectedExitCode),
          );
        }
      },
    );
    return readRestartSentinel({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  };

  const fixture = {
    baseConfig,
    baseSnapshot,
    clawHubRiskWarning,
    clawHubSuspiciousPayloadWarning,
    clawHubSyncRiskError,
    completeChangedPostCorePluginUpdate,
    configSnapshot,
    createCaseDir,
    expectFailedManagedGitRestart,
    expectFreshPostUpdateDoctor,
    fixtureRoot,
    fixtureStateDatabases,
    FRESH_POST_UPDATE_ENTRYPOINT,
    globalNpmConfig,
    initializeExistingUpdateProfile,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockGatewayInstallFailure,
    mockNoopPostUpdatePluginConvergence,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockNpmPluginOutcomes,
    mockOwnedGitService,
    mockPackageGatewayLifecycle,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockPackageReplacementFailure,
    mockPostDoctorSnapshot,
    mockRunningManagedGateway,
    mockServicePackageCommands,
    mockStoppedManagedGitGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    reportCandidateSteps,
    runControlPlaneUpdate,
    runPostCoreCommand,
    runPostCoreUpdate,
    runRestartFallbackScenario,
    runUpdateCliScenario,
    runWithGatewayServiceEnv,
    setStdoutTty,
    setTty,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    setupManagedGitRootRefresh,
    setupNonInteractiveDowngrade,
    setupNpmUpdatedRootRefresh,
    setupPostCoreConfigFixture,
    setupServicePackageAtPrefix,
    setupUpdatedRootRefresh,
    statfsFixture,
    tempDirs,
    tempDirsToCleanup,
    useFileBackedConfig,
    useNativeScheduledTaskControl,
  };
  registerUpdateCliLifecycle(fixture);
  return fixture;
}

export type UpdateCliFixture = ReturnType<typeof createUpdateCliFixture>;
