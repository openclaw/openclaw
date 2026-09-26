import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../daemon/constants.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as updateTempRoot from "../infra/tmp-openclaw-dir.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as windowsPrivateDirectory from "../infra/windows-private-directory.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { getFreePort } from "../test-utils/ports.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { setupConfigMutationWithRetryMock } from "./update-cli-assertions.test-support.js";
import {
  candidateValidation,
  checkShellCompletionStatus,
  classifyPortListener,
  commandTransport,
  confirm,
  databasePreflightMocks,
  ensureCompletionCacheExists,
  existingHostUri,
  fixtureEnvSnapshot,
  formatPortDiagnostics,
  gatewayFixturePid,
  httpReadiness,
  immutableHostUri,
  inferenceRepair,
  inspectPortUsage,
  installCompletion,
  launchdUpdateCleanupMocks,
  legacyConfigRepairMocks,
  mockGetSelfAndAncestorPidsSync,
  nodeVersionSatisfiesEngine,
  pathExists,
  pluginAvailabilityPreflight,
  probePortUsage,
  readPackageName,
  readPackageVersion,
  readPersistedInstalledPluginIndex,
  resetRuntimeCapture,
  resolveGlobalManager,
  resolveNodeRuntimeInfo,
  restartHealthTestControl,
  restorePersistedInstalledPluginIndexIfCurrent,
  resumeScheduledTaskAutoStartAfterUpdate,
  retainUpdateRuntime,
  select,
  serviceDefinitionMutationCapability,
  serviceEnabled,
  serviceFixtureState,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  sourceRuntimeCompletion,
  spawn,
  sqliteHostPlatform,
  stateSchemaVersions,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  systemdPolicy,
  terminateStaleGatewayPids,
  triageAfterFailure,
  updateFailureActionMocks,
  updateNpmInstalledPlugins,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./update-cli-mocks.test-support.js";
import {
  checkUpdateStatus,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  defaultRuntime,
  doctorCommand,
  fetchNpmPackageTargetStatus,
  fetchNpmTagVersion,
  makeOkUpdateResult,
  mockUpdateStateSnapshotWorker,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  resolveExtendedStablePackage,
  resolveOpenClawPackageRoot,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runCommandWithTimeout,
  runDaemonInstall,
  runDaemonRestart,
  updateCliShared,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  npmPluginUpdateResult,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import { reportUpdateCliHomeCleanupFailure } from "./update-cli/update-cli-failure-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

type UpdateCliLifecycleFixture = {
  baseConfig: ConfigFileSnapshot["config"];
  baseSnapshot: ConfigFileSnapshot;
  fixtureRoot: string;
  fixtureStateDatabases: Set<string>;
  globalNpmConfig: string;
  initializeExistingUpdateProfile: () => void;
  mockGatewayHealth: (version: string, connId: string) => void;
  primeNpmChannelTag: (tag: string, version: string | null) => void;
  reportCandidateSteps: <T extends { steps: UpdateRunResult["steps"] }>(
    options: { onStep?: (step: UpdateRunResult["steps"][number]) => void },
    result: T,
  ) => T;
  setStdoutTty: (value: boolean | undefined) => void;
  setTty: (value: boolean | undefined) => void;
  tempDirs: { make: (prefix: string) => string };
  tempDirsToCleanup: Set<string>;
};

export function registerUpdateCliLifecycle(fixture: UpdateCliLifecycleFixture): void {
  const {
    baseConfig,
    baseSnapshot,
    fixtureRoot,
    fixtureStateDatabases,
    globalNpmConfig,
    initializeExistingUpdateProfile,
    mockGatewayHealth,
    primeNpmChannelTag,
    reportCandidateSteps,
    setStdoutTty,
    setTty,
    tempDirs,
    tempDirsToCleanup,
  } = fixture;
  let tempHome: TempHomeEnv | undefined;

  beforeEach(async () => {
    fixtureStateDatabases.clear();
    process.exitCode = undefined;
    const { createTempHomeEnv } = await import("../test-utils/temp-home.js");
    tempHome = await createTempHomeEnv("openclaw-update-cli-home-");
    commandTransport.npmPrefix = tempDirs.make("openclaw-cli-npm-prefix-");
    process.env.NPM_CONFIG_GLOBALCONFIG = globalNpmConfig;
    process.env.npm_config_globalconfig = globalNpmConfig;
    const executorTmp = tempDirs.make("update-cli-owner-");
    serviceFixtureState.absentServicePort = await getFreePort();
    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    delete process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
    for (const key of [
      ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
      ...SUPERVISOR_HINT_ENV_VARS,
      "OPENCLAW_UPDATE_RUN_HANDOFF",
    ]) {
      delete process.env[key];
    }
    restartHealthTestControl.snapshot = undefined;
    vi.resetAllMocks();
    retainUpdateRuntime.mockImplementation(async ({ assertCurrent }) => assertCurrent());
    systemdPolicy.mockResolvedValue(false);
    mockUpdateStateSnapshotWorker(fixtureStateDatabases);
    // Service simulations do not provide foreign-platform ACL libraries. Keep
    // real exclusive host creation; actual Windows runs retain the native DACL path.
    if (sqliteHostPlatform !== "win32") {
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsDirectory").mockImplementation(
        (directoryPath) => {
          fsSync.mkdirSync(directoryPath, { mode: 0o700 });
        },
      );
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsFile").mockImplementation((filePath) =>
        fsSync.openSync(
          filePath,
          fsSync.constants.O_RDWR |
            fsSync.constants.O_CREAT |
            fsSync.constants.O_EXCL |
            fsSync.constants.O_NOFOLLOW,
          0o600,
        ),
      );
    }
    // Native-service platform simulations do not change the actual SQLite VFS.
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((file) =>
      existingHostUri(file, sqliteHostPlatform),
    );
    vi.spyOn(nodeSqlite, "resolveImmutableSqliteFileUri").mockImplementation((file) =>
      immutableHostUri(file, sqliteHostPlatform),
    );
    vi.spyOn(updateTempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(executorTmp);
    const pidAlive = await import("../shared/pid-alive.js");
    const readHostProcessStartTime = pidAlive.getFileLockProcessStartTime;
    // Service-platform doubles cannot change the OS that owns real fixture PIDs.
    // Keep actual PID/start reads, switching only their synchronous platform dispatch.
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((...args) => {
      if (process.platform === sqliteHostPlatform) {
        return readHostProcessStartTime(...args);
      }
      const descriptor = expectDefined(
        Object.getOwnPropertyDescriptor(process, "platform"),
        "host platform descriptor",
      );
      Object.defineProperty(process, "platform", {
        configurable: true,
        enumerable: descriptor.enumerable,
        value: sqliteHostPlatform,
      });
      try {
        return readHostProcessStartTime(...args);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
    // Cache the real host process identity before cases spoof the native service
    // platform. Lease ownership still uses the production PID/start checks.
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    expect(getFileLockProcessStartTime(process.pid)).not.toBeNull();
    pluginAvailabilityPreflight.mockResolvedValue([]);
    sourceRuntimeCompletion.mockResolvedValue({ changed: false });
    triageAfterFailure.mockResolvedValue(undefined);
    inferenceRepair.mockResolvedValue({
      status: "unavailable",
      attempts: [],
      finalValidation: { ok: false, score: 0, summary: "No fixture repair route." },
    });
    candidateValidation.mockImplementation(async (options) =>
      reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [
          {
            name: "candidate-gateway-startup",
            command: "openclaw gateway",
            cwd: "/candidate",
            durationMs: 1,
            exitCode: 0,
          },
        ],
      }),
    );
    httpReadiness.mockResolvedValue({ healthz: 200, readyz: 200 });

    stateSchemaVersions.mockImplementation(
      async ({ stateDir, env }: { stateDir: string; env?: NodeJS.ProcessEnv }) => [
        { path: resolveOpenClawStateSqlitePath(env), userVersion: OPENCLAW_STATE_SCHEMA_VERSION },
        {
          path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          userVersion: null,
        },
      ],
    );
    probePortUsage.mockResolvedValue("free");
    serviceEnabled.mockResolvedValue(true);
    serviceDefinitionMutationCapability.mockResolvedValue(undefined);
    updateFailureActionMocks.runInteractiveUpdateFailureAction.mockResolvedValue("triage");
    readPersistedInstalledPluginIndex.mockResolvedValue(null);
    restorePersistedInstalledPluginIndexIfCurrent.mockResolvedValue(true);
    writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: null,
      revision: 1,
    });
    resetRuntimeCapture();
    spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [],
      indeterminate: [],
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue(baseSnapshot.config);
    setupConfigMutationWithRetryMock();
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(fetchNpmPackageTargetStatus).mockImplementation(async ({ target }) => ({
      target,
      version: /^\d/u.test(target) ? target : "9999.0.0",
      nodeEngine: ">=22.19.0",
    }));
    vi.mocked(resolveExtendedStablePackage).mockResolvedValue({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });
    primeNpmChannelTag("latest", "9999.0.0");
    nodeVersionSatisfiesEngine.mockReturnValue(true);
    resolveNodeRuntimeInfo.mockResolvedValue({
      status: "supported",
      version: process.versions.node,
      sqliteVersion: "3.51.3",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
    });
    vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: "v1.2.3", branch: "main" },
    });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[2] === "gateway" && argv[3] === "stop") {
        return commandResult({
          stdout: JSON.stringify({ action: "stop", ok: true, result: "stopped" }),
        });
      }
      if (argv[0] === "npm" && argv[1] === "pack") {
        const destination = argv[argv.indexOf("--pack-destination") + 1];
        if (destination) {
          await fs.writeFile(path.join(destination, "openclaw-9999.0.0.tgz"), "packed\n", "utf8");
        }
      }
      return commandResult();
    });
    vi.spyOn(updateCliShared, "readPackageName").mockImplementation(readPackageName);
    vi.spyOn(updateCliShared, "readPackageVersion").mockImplementation(readPackageVersion);
    vi.spyOn(updateCliShared, "resolveGlobalManager").mockImplementation(resolveGlobalManager);
    readPackageName.mockResolvedValue("openclaw");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceStart.mockResolvedValue(undefined);
    serviceStop.mockResolvedValue(undefined);
    terminateStaleGatewayPids.mockResolvedValue(undefined);
    serviceRestart.mockResolvedValue({ outcome: "completed" });
    mockSystemAccountHome();
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(false);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(false);
    serviceLoaded.mockResolvedValue(false);
    serviceReadCommand.mockImplementation(async () =>
      (await serviceLoaded()) ? { programArguments: ["openclaw", "gateway", "run"] } : null,
    );
    serviceReadRuntime.mockImplementation(async () =>
      (await serviceLoaded())
        ? { status: "running", pid: gatewayFixturePid, state: "running" }
        : { status: "stopped", state: "stopped", missingUnit: true },
    );
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    mockGatewayHealth("1.0.0", "conn-test");
    const installedEntrypoint = path.join(process.cwd(), "dist", "index.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === installedEntrypoint);
    syncPluginsForUpdateChannel.mockResolvedValue(pluginSyncResult(baseConfig));
    updateNpmInstalledPlugins.mockResolvedValue(npmPluginUpdateResult(baseConfig));
    checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: false,
    });
    ensureCompletionCacheExists.mockResolvedValue(true);
    installCompletion.mockResolvedValue(undefined);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
      async (params: { configSnapshot: ConfigFileSnapshot }) => ({
        snapshot: params.configSnapshot,
        repaired: false,
      }),
    );
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockReset();
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(false);
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(updateGitCheckout).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
    initializeExistingUpdateProfile();
  });

  afterAll(async () => {
    fixtureEnvSnapshot.restore();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    // Relocated stores can retain workers whose coordinator lives in this temporary home.
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    try {
      await tempHome?.restore();
    } catch (error) {
      reportUpdateCliHomeCleanupFailure(tempHome);
      throw error;
    }
    tempHome = undefined;
    await Promise.allSettled(
      [...tempDirsToCleanup].map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirsToCleanup.clear();
  });
}
