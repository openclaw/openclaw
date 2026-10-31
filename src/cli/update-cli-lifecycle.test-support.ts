import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createDirectorySync, createFileSync } from "@openclaw/fs-safe/advanced";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import * as sourceArtifactPreflight from "../../scripts/lib/source-update-artifact-preflight.mts";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../daemon/constants.js";
import * as taskProbe from "../daemon/schtasks-state-probe.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as sqliteHeaderProbe from "../infra/sqlite-header-probe.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as updateTempRoot from "../infra/tmp-openclaw-dir.js";
import * as stateMetadata from "../infra/update-candidate-state.sizes.js";
import * as updateDatabaseRestore from "../infra/update-database-restore.js";
import * as updateRecoveryBaseline from "../infra/update-recovery-baseline-capture.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as windowsPrivateDirectory from "../infra/windows-private-directory.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { getFreePort } from "../test-utils/ports.js";
import type { TempHomeEnv } from "../test-utils/temp-home.js";
import { setupConfigMutationWithRetryMock } from "./update-cli-assertions.test-support.js";
import { createGitUpdateAfterMutationFixture } from "./update-cli-invocation.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import {
  npmPluginUpdateResult,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import { reportUpdateCliHomeCleanupFailure } from "./update-cli/update-cli-failure-recovery.test-support.js";
import { runtimeFixture } from "./update-cli/update-command-fixtures.test-support.js";
import { getNodeRuntimeFixture } from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

export const candidateStartupStep = (cwd: string, valid = true) => ({
  name: "candidate-gateway-startup",
  command: "openclaw gateway",
  cwd,
  durationMs: 1,
  exitCode: valid ? 0 : 1,
  ...(!valid ? { stderrTail: "candidate readiness failed" } : {}),
});

function selectHostPlatform() {
  const descriptor = expectDefined(
    Object.getOwnPropertyDescriptor(process, "platform"),
    "host platform descriptor",
  );
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: descriptor.enumerable,
    value: mocks.sqliteHostPlatform,
  });
  return { [Symbol.dispose]: () => Object.defineProperty(process, "platform", descriptor) };
}

async function onHostPlatform<T>(operation: () => Promise<T>): Promise<T> {
  using _ = selectHostPlatform();
  return await operation();
}

type UpdateCliLifecycleFixture = {
  baseConfig: ConfigFileSnapshot["config"];
  baseSnapshot: ConfigFileSnapshot;
  fixtureRoot: string;
  globalNpmConfig: string;
  initializeExistingUpdateProfile: () => void;
  mockGatewayHealth: (version: string, connId: string) => void;
  primeNpmChannelTag: (tag: string, version: string | null) => void;
  reportCandidateSteps: <T extends { steps: UpdateRunResult["steps"] }>(
    options: { onStep?: (step: UpdateRunResult["steps"][number]) => void | Promise<void> },
    result: T,
  ) => Promise<T>;
  setStdoutTty: (value: boolean | undefined) => void;
  setTty: (value: boolean | undefined) => void;
  tempDirs: { make: (prefix: string) => string };
  tempDirsToCleanup: Set<string>;
};

export function registerUpdateCliLifecycle(fixture: UpdateCliLifecycleFixture): void {
  let tempHome: TempHomeEnv | undefined;

  const invocationCwd = process.cwd();
  beforeEach(async () => {
    vi.spyOn(taskProbe, "probeScheduledTaskUpdateAccess").mockReturnValue({ status: "allowed" });
    // Default install roots use cwd; artifact admission must own the fixture, not the checkout.
    const checkoutRoot = path.join(fixture.fixtureRoot, "checkout");
    process.chdir(checkoutRoot);
    process.exitCode = undefined;
    const { createTempHomeEnv } = await import("../test-utils/temp-home.js");
    tempHome = await createTempHomeEnv("openclaw-update-cli-home-");
    // Original-state capture must discover this simulated install's plugins.
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(checkoutRoot, "extensions");
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    mocks.commandTransport.npmPrefix = fixture.tempDirs.make("openclaw-cli-npm-prefix-");
    process.env.NPM_CONFIG_GLOBALCONFIG = fixture.globalNpmConfig;
    process.env.npm_config_globalconfig = fixture.globalNpmConfig;
    const executorTmp = fixture.tempDirs.make("update-cli-owner-");
    mocks.serviceFixtureState.absentServicePort = await getFreePort();
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
    mocks.restartHealthTestControl.snapshot = undefined;
    vi.resetAllMocks();
    // Metadata process isolation has its own tests; keep real file and sidecar sizes here.
    vi.spyOn(stateMetadata, "readUpdateStateDatabaseSizes").mockImplementation(
      (files, { signal }) => stateMetadata.readUpdateStateDatabaseSizesInProcess(files, signal),
    );
    // Service control is simulated; native artifact and database owners still run on the host OS.
    const inspectArtifacts = sourceArtifactPreflight.inspectSourceUpdateArtifacts;
    vi.spyOn(sourceArtifactPreflight, "inspectSourceUpdateArtifacts").mockImplementation(
      async (...args) => {
        const inspected = await onHostPlatform(() => inspectArtifacts(...args));
        const { lock } = inspected;
        if (!lock) {
          return inspected;
        }
        const release = () => onHostPlatform(() => lock.release());
        return {
          ...inspected,
          lock: {
            ...lock,
            release,
            verifyStillHeld: () => onHostPlatform(() => lock.verifyStillHeld()),
            [Symbol.asyncDispose]: release,
          },
        };
      },
    );
    const captureBaseline = updateRecoveryBaseline.captureUpdateRecoveryBaseline;
    vi.spyOn(updateRecoveryBaseline, "captureUpdateRecoveryBaseline").mockImplementation(
      (...args) => onHostPlatform(() => captureBaseline(...args)),
    );
    const restoreDatabaseBackup = updateDatabaseRestore.restoreUpdateDatabaseBackup;
    vi.spyOn(updateDatabaseRestore, "restoreUpdateDatabaseBackup").mockImplementation((...args) =>
      onHostPlatform(() => restoreDatabaseBackup(...args)),
    );
    mocks.retainUpdateRuntime.mockImplementation(async ({ assertCurrent }) => assertCurrent());
    mocks.systemdPolicy.mockResolvedValue({ kind: "unchanged" });
    // Keep host file exclusivity; native Windows still tests DACL creation.
    if (mocks.sqliteHostPlatform !== "win32") {
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsDirectory").mockImplementation(
        (directoryPath) => {
          createDirectorySync(directoryPath, { mode: 0o700 });
        },
      );
      vi.spyOn(windowsPrivateDirectory, "createPrivateWindowsFile").mockImplementation((file) =>
        createFileSync(file, { mode: 0o600 }),
      );
    }
    // Service-platform doubles do not change host SQLite helpers or their Node resolution.
    const probeSqliteHeaders = sqliteHeaderProbe.probeSqliteDatabaseHeaders;
    vi.spyOn(sqliteHeaderProbe, "probeSqliteDatabaseHeaders").mockImplementation((...args) => {
      using _ = selectHostPlatform();
      return probeSqliteHeaders(...args);
    });
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((file) =>
      mocks.existingHostUri(file, mocks.sqliteHostPlatform),
    );
    vi.spyOn(nodeSqlite, "resolveImmutableSqliteFileUri").mockImplementation((file) =>
      mocks.immutableHostUri(file, mocks.sqliteHostPlatform),
    );
    vi.spyOn(updateTempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(executorTmp);
    const pidAlive = await import("../shared/pid-alive.js");
    const readHostProcessStartTime = pidAlive.getFileLockProcessStartTime;
    // Read real PID/start identity using the host OS despite service-platform doubles.
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((...args) => {
      using _ = selectHostPlatform();
      return readHostProcessStartTime(...args);
    });
    // Cache real PID/start identity before cases spoof the service platform.
    expect(pidAlive.getFileLockProcessStartTime(process.pid)).not.toBeNull();
    mocks.pluginAvailabilityPreflight.mockResolvedValue([]);
    mocks.sourceRuntimeCompletion.mockResolvedValue({ changed: false });
    mocks.triageAfterFailure.mockResolvedValue(undefined);
    mocks.inferenceRepair.mockResolvedValue({
      status: "unavailable",
      attempts: [],
      finalValidation: { ok: false, score: 0, summary: "No fixture repair route." },
    });
    mocks.candidateValidation.mockImplementation(async (options) =>
      fixture.reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [candidateStartupStep("/candidate")],
      }),
    );
    mocks.httpReadiness.mockResolvedValue({ healthz: 200, readyz: 200 });

    mocks.stateSchemaVersions.mockImplementation(
      async ({ stateDir, env }: { stateDir: string; env?: NodeJS.ProcessEnv }) => [
        { path: resolveOpenClawStateSqlitePath(env), userVersion: OPENCLAW_STATE_SCHEMA_VERSION },
        {
          path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          userVersion: null,
        },
      ],
    );
    mocks.probePortUsage.mockResolvedValue("free");
    mocks.serviceEnabled.mockResolvedValue(true);
    mocks.serviceDefinitionMutationCapability.mockResolvedValue(undefined);
    mocks.readPersistedInstalledPluginIndex.mockResolvedValue(null);
    mocks.restorePersistedInstalledPluginIndexIfCurrent.mockResolvedValue(true);
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: null,
      revision: 1,
    });
    mocks.resetRuntimeCapture();
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });
    vi.mocked(update.defaultRuntime.exit).mockImplementation(() => {});
    mocks.databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [],
      indeterminate: [],
    });
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(update.readConfigFileSnapshot).mockResolvedValue(fixture.baseSnapshot);
    vi.mocked(update.readSourceConfigBestEffort).mockResolvedValue(fixture.baseSnapshot.config);
    setupConfigMutationWithRetryMock();
    vi.mocked(update.fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(update.fetchNpmPackageTargetStatus).mockImplementation(async ({ target }) => ({
      version: /^\d/u.test(target) ? target : "9999.0.0",
      nodeEngine: ">=22.19.0",
    }));
    vi.mocked(update.resolveExtendedStablePackage).mockResolvedValue({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });
    fixture.primeNpmChannelTag("latest", "9999.0.0");
    mocks.nodeVersionSatisfiesEngine.mockReturnValue(true);
    const { versions } = getNodeRuntimeFixture();
    mocks.resolveNodeRuntimeInfo.mockResolvedValue(runtimeFixture(versions.node, versions.sqlite));
    vi.mocked(update.resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(update.resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: "v1.2.3", branch: "main" },
    });
    vi.mocked(update.checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
    });
    vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv) => {
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
    vi.spyOn(update.updateCliShared, "readPackageName").mockImplementation(mocks.readPackageName);
    vi.spyOn(update.updateCliShared, "readPackageVersion").mockImplementation(
      mocks.readPackageVersion,
    );
    vi.spyOn(update.updateCliShared, "resolveGlobalManager").mockImplementation(
      mocks.resolveGlobalManager,
    );
    mocks.readPackageName.mockResolvedValue("openclaw");
    mocks.readPackageVersion.mockResolvedValue("1.0.0");
    mocks.resolveGlobalManager.mockResolvedValue("npm");
    mocks.serviceStart.mockResolvedValue(undefined);
    mocks.serviceStop.mockResolvedValue(undefined);
    mocks.terminateStaleGatewayPids.mockResolvedValue(undefined);
    mocks.serviceRestart.mockResolvedValue({ outcome: "completed" });
    mockSystemAccountHome();
    mocks.suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(false);
    mocks.resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(false);
    mocks.serviceLoaded.mockResolvedValue(false);
    mocks.serviceReadCommand.mockImplementation(async () =>
      (await mocks.serviceLoaded()) ? { programArguments: ["openclaw", "gateway", "run"] } : null,
    );
    mocks.serviceReadRuntime.mockImplementation(async () =>
      (await mocks.serviceLoaded())
        ? { status: "running", pid: mocks.gatewayFixturePid, state: "running" }
        : { status: "stopped", state: "stopped", missingUnit: true },
    );
    mocks.mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid, 1]));
    mocks.inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: mocks.gatewayFixturePid, command: "openclaw-gateway" }],
      hints: [],
    });
    mocks.classifyPortListener.mockReturnValue("gateway");
    mocks.formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    fixture.mockGatewayHealth("1.0.0", "conn-test");
    const installedEntrypoint = path.join(process.cwd(), "dist", "index.js");
    mocks.pathExists.mockImplementation(
      async (candidate: string) => candidate === installedEntrypoint,
    );
    mocks.syncPluginsForUpdateChannel.mockResolvedValue(pluginSyncResult(fixture.baseConfig));
    mocks.updateNpmInstalledPlugins.mockResolvedValue(npmPluginUpdateResult(fixture.baseConfig));
    mocks.checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: false,
    });
    mocks.ensureCompletionCacheExists.mockResolvedValue(true);
    mocks.installCompletion.mockResolvedValue(undefined);
    vi.mocked(update.runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(update.runDaemonRestart).mockResolvedValue(true);
    vi.mocked(update.doctorCommand).mockResolvedValue(undefined);
    mocks.legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
      async (params: { configSnapshot: ConfigFileSnapshot }) => ({
        snapshot: params.configSnapshot,
        repaired: false,
      }),
    );
    mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(false);
    mocks.confirm.mockResolvedValue(false);
    mocks.select.mockResolvedValue("stable");
    vi.mocked(update.updateGitCheckout).mockImplementation(
      createGitUpdateAfterMutationFixture().run,
    );
    fixture.setTty(false);
    fixture.setStdoutTty(false);
    fixture.initializeExistingUpdateProfile();
    // Keep guard reads on the fixture connection instead of booting snapshots per read.
    openOpenClawStateDatabase();
  });

  afterAll(async () => {
    mocks.fixtureEnvSnapshot.restore();
    // Direct command fixtures also own the native broker started from their checkout.
    await closeDefaultRetainedNativeWorkerSource();
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(invocationCwd);
    process.exitCode = undefined;
    // Relocated stores can retain workers whose coordinator lives in this temporary home.
    await update.closeOpenClawStateDatabaseAsync();
    update.closeOpenClawStateDatabaseForTest();
    try {
      await tempHome?.restore();
    } catch (error) {
      reportUpdateCliHomeCleanupFailure(tempHome);
      throw error;
    }
    tempHome = undefined;
    await Promise.allSettled(
      [...fixture.tempDirsToCleanup].map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    fixture.tempDirsToCleanup.clear();
  });
}
