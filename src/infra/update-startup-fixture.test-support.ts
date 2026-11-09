import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import {
  cancelManagedServiceUpdateHandoffMock,
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  getRuntimeConfigMock,
  runUpdateFailureTriageMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  versionMock,
} from "./update-startup.test-support.js";

const UPDATE_CHECK_STATE_KEY = "update.checkState";

type PersistedUpdateCheckState = {
  lastCheckedAt?: string;
  lastCheckedChannel?: "stable" | "extended-stable" | "beta" | "dev";
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
};

// Each caller owns isolated state and scheduler resources; mocks remain in the hoisted support module.
export function useUpdateStartupTestFixture() {
  let tempDir: string;
  let testState: OpenClawTestState;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let handoffTransferStarted: ReturnType<typeof createDeferred<void>>;
  let triageResult: Extract<
    Awaited<ReturnType<typeof runUpdateFailureTriageMock>>,
    { status: "completed" }
  >;

  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];
  let resolveNpmChannelTag: (typeof import("./update-check.js"))["resolveNpmChannelTag"];
  let runCommandWithTimeout: (typeof import("../process/exec.js"))["runCommandWithTimeout"];
  let runGatewayUpdateCheckOwner: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];
  let createGatewayUpdateCheck: (typeof import("./update-startup.js"))["createGatewayUpdateCheck"];
  let getUpdateAvailable: (typeof import("./update-status-state.js"))["getUpdateAvailable"];
  let getUpdateEffectiveChannel: (typeof import("./update-startup.js"))["getUpdateEffectiveChannel"];
  let getUpdateSchedule: (typeof import("./update-status-state.js"))["getUpdateSchedule"];
  let refreshGatewayUpdateStatus: (typeof import("./update-status-schedule.js"))["refreshGatewayUpdateStatus"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];
  let loaded = false;
  const updateChecks = new Set<ReturnType<typeof createGatewayUpdateCheck>>();

  type UpdateCheckFixtureParams = Omit<
    Parameters<typeof createGatewayUpdateCheck>[0],
    "getConfig" | "log" | "isNixMode" | "lifecycle" | "applyRemoteCatalogUpdate"
  > & {
    cfg: OpenClawConfig;
    log?: Parameters<typeof createGatewayUpdateCheck>[0]["log"];
    isNixMode?: boolean;
    applyRemoteCatalogUpdate?: Parameters<
      typeof createGatewayUpdateCheck
    >[0]["applyRemoteCatalogUpdate"];
  };

  function createTestUpdateCheck({
    cfg,
    log = { info: vi.fn() },
    isNixMode = false,
    applyRemoteCatalogUpdate = async () => "unchanged",
    ...params
  }: UpdateCheckFixtureParams) {
    const check = createGatewayUpdateCheck({
      ...params,
      log,
      isNixMode,
      getConfig: () => cfg,
      applyRemoteCatalogUpdate,
      lifecycle: createGatewayUpdateLifecycle(scheduler),
    });
    updateChecks.add(check);
    return check;
  }

  function scheduleGatewayUpdateCheck(params: UpdateCheckFixtureParams) {
    const check = createTestUpdateCheck(params);
    check.start();
    return check.stop;
  }

  function runGatewayUpdateCheck({
    cfg,
    log = { info: vi.fn() },
    isNixMode = false,
    allowInTests = true,
    ...params
  }: Omit<Parameters<typeof runGatewayUpdateCheckOwner>[0], "getConfig" | "log" | "isNixMode"> & {
    cfg: OpenClawConfig;
    log?: UpdateCheckFixtureParams["log"];
    isNixMode?: boolean;
  }) {
    return runGatewayUpdateCheckOwner({
      ...params,
      log,
      isNixMode,
      allowInTests,
      getConfig: () => cfg,
    });
  }

  function readPersistedUpdateCheckState(): PersistedUpdateCheckState | null {
    return readConfigMachineState<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? null;
  }

  function writePersistedUpdateCheckState(state: PersistedUpdateCheckState): void {
    writeConfigMachineState(UPDATE_CHECK_STATE_KEY, { lastCheckedChannel: "stable", ...state });
  }

  beforeEach(async () => {
    versionMock.value = "1.0.0";
    clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    scheduler = createTestGatewayScheduler(clock.clock);
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-update-check-suite-",
      env: {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_GATEWAY_SERVICE_PID: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        INVOCATION_ID: undefined,
        NODE_ENV: "test",
        VITEST: undefined,
      },
    });
    tempDir = testState.stateDir;
    triageResult = {
      status: "completed",
      hint: `Triage prompt: ${path.join(tempDir, "triage-prompt.md")}`,
    };
    runUpdateFailureTriageMock.mockReset().mockResolvedValue(triageResult);

    // Perf: load mocked modules once (after clock/env are set up).
    if (!loaded) {
      ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
      ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
      ({ runCommandWithTimeout } = await import("../process/exec.js"));
      ({
        runGatewayUpdateCheck: runGatewayUpdateCheckOwner,
        createGatewayUpdateCheck,
        getUpdateEffectiveChannel,
        resetUpdateAvailableStateForTest,
      } = await import("./update-startup.js"));
      ({ refreshGatewayUpdateStatus } = await import("./update-status-schedule.js"));
      ({ getUpdateAvailable, getUpdateSchedule } = await import("./update-status-state.js"));
      loaded = true;
    }
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    checkTelemetryUpdateMock.mockReset().mockResolvedValue(null);
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockReset().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({});
    refreshRemoteModelCatalogMock.mockReset().mockResolvedValue({
      status: "unchanged",
      providers: 1,
      models: 1,
      generatedAt: 1_753_500_000_000,
    });
    detectRespawnSupervisorMock.mockReset();
    detectRespawnSupervisorMock.mockReturnValue(null);
    scheduleGatewayRestartMock.mockClear();
    startManagedServiceUpdateHandoffMock.mockClear();
    handoffTransferStarted = createDeferred();
    transferManagedServiceUpdateHandoffMock.mockReset().mockImplementation(async () => {
      handoffTransferStarted.resolve();
      return true;
    });
    cancelManagedServiceUpdateHandoffMock.mockReset().mockResolvedValue("restored-in-process");
    startManagedServiceUpdateHandoffMock.mockResolvedValue({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --channel beta",
      logPath: "/tmp/openclaw-handoff.log",
      handoffId: "auto-handoff-id",
      installRoot: "/opt/openclaw",
    });
    resetUpdateAvailableStateForTest(scheduler);
    createTestUpdateCheck({ cfg: {} });
  });

  afterEach(async () => {
    await Promise.all([...updateChecks].map((check) => check.stop()));
    updateChecks.clear();
    resetUpdateAvailableStateForTest(scheduler);
    await scheduler.stop();
    vi.restoreAllMocks();
    await testState.cleanup();
  });

  afterAll(closeStateDatabaseForTest);
  function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
    mockPackageInstallStatus();
    mockNpmChannelTag(tag, version);
  }

  function mockPackageInstallStatus(root = "/opt/openclaw") {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
  }

  function mockNpmChannelTag(tag: string, version: string) {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag,
      version,
    });
    checkTelemetryUpdateMock.mockResolvedValue({ version });
  }

  function mockDevGitStatus(params?: Parameters<typeof createDevGitStatus>[0]) {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    const status = createDevGitStatus(params);
    vi.mocked(checkUpdateStatus).mockResolvedValue(status);
    return status;
  }

  function createAutoUpdateSuccessMock() {
    return vi.fn().mockResolvedValue({
      status: "handoff",
    });
  }

  function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
    return {
      getQueueSize: () => 0,
      getPendingReplies: () => 0,
      getEmbeddedRuns: () => 0,
      getBackgroundExecSessions: () => 0,
      getCronRuns: () => 0,
      getAgentRuns: () => 0,
      getAcpRuns: () => 0,
      getMediaRuns: () => 0,
      getRootRequests: () => 0,
      getSessionAdmissions: () => 0,
      getSessionMutations: () => 0,
      getChatRuns: () => 0,
      getQueuedTurns: () => 0,
      getTerminalPersistence: () => 0,
      getTerminalSessions: () => 0,
    };
  }

  function createBetaAutoUpdateConfig() {
    return {
      update: {
        channel: "beta" as const,
        auto: {
          enabled: true,
        },
      },
    };
  }

  async function runAutoUpdateCheckWithDefaults(
    params: Parameters<typeof runGatewayUpdateCheck>[0],
  ) {
    await runGatewayUpdateCheck({ activeWorkInspectors: idleActiveWorkInspectors(), ...params });
    await clock.advanceBy(60_000);
  }

  return {
    createTestUpdateCheck,
    scheduleGatewayUpdateCheck,
    runGatewayUpdateCheck,
    readPersistedUpdateCheckState,
    writePersistedUpdateCheckState,
    mockPackageUpdateStatus,
    mockPackageInstallStatus,
    mockNpmChannelTag,
    mockDevGitStatus,
    createAutoUpdateSuccessMock,
    idleActiveWorkInspectors,
    createBetaAutoUpdateConfig,
    runAutoUpdateCheckWithDefaults,
    get clock() {
      return clock;
    },
    get scheduler() {
      return scheduler;
    },
    get handoffTransferStarted() {
      return handoffTransferStarted;
    },
    get triageResult() {
      return triageResult;
    },
    get resolveOpenClawPackageRoot() {
      return resolveOpenClawPackageRoot;
    },
    get checkUpdateStatus() {
      return checkUpdateStatus;
    },
    get resolveNpmChannelTag() {
      return resolveNpmChannelTag;
    },
    get runCommandWithTimeout() {
      return runCommandWithTimeout;
    },
    get runGatewayUpdateCheckOwner() {
      return runGatewayUpdateCheckOwner;
    },
    get createGatewayUpdateCheck() {
      return createGatewayUpdateCheck;
    },
    get getUpdateAvailable() {
      return getUpdateAvailable;
    },
    get getUpdateEffectiveChannel() {
      return getUpdateEffectiveChannel;
    },
    get getUpdateSchedule() {
      return getUpdateSchedule;
    },
    get refreshGatewayUpdateStatus() {
      return refreshGatewayUpdateStatus;
    },
    get resetUpdateAvailableStateForTest() {
      return resetUpdateAvailableStateForTest;
    },
    get updateChecks() {
      return updateChecks;
    },
  };
}
