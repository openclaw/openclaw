// Shared mocks and lifecycle for the focused update-startup suites.
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
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

const {
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
} = await vi.hoisted(() => import("./update-startup.test-support.js"));

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

let tempDir: string;

let testState: OpenClawTestState;

export let scheduler: ReturnType<typeof createTestGatewayScheduler>;

export let clock: ReturnType<typeof createGatewaySchedulerClock>;

export let handoffTransferStarted: ReturnType<typeof createDeferred<void>>;

export let triageResult: Extract<
  Awaited<ReturnType<typeof runUpdateFailureTriageMock>>,
  { status: "completed" }
>;

export let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];

export let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];

export let resolveNpmChannelTag: (typeof import("./update-check.js"))["resolveNpmChannelTag"];

export let runCommandWithTimeout: (typeof import("../process/exec.js"))["runCommandWithTimeout"];

export let runGatewayUpdateCheckOwner: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];

export let createGatewayUpdateCheck: (typeof import("./update-startup.js"))["createGatewayUpdateCheck"];

export let getUpdateAvailable: (typeof import("./update-status-state.js"))["getUpdateAvailable"];

export let getUpdateEffectiveChannel: (typeof import("./update-startup.js"))["getUpdateEffectiveChannel"];

export let getUpdateSchedule: (typeof import("./update-status-state.js"))["getUpdateSchedule"];

export let refreshGatewayUpdateStatus: (typeof import("./update-status-schedule.js"))["refreshGatewayUpdateStatus"];

export let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];

let loaded = false;

export const updateChecks = new Set<ReturnType<typeof createGatewayUpdateCheck>>();

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

export function createTestUpdateCheck({
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

export function scheduleGatewayUpdateCheck(params: UpdateCheckFixtureParams) {
  const check = createTestUpdateCheck(params);
  check.start();
  return check.stop;
}

export function runGatewayUpdateCheck({
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

export function readPersistedUpdateCheckState(): PersistedUpdateCheckState | null {
  return readConfigMachineState<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? null;
}

export function expectLastTelemetryConfig(config: OpenClawConfig) {
  const call = checkTelemetryUpdateMock.mock.lastCall;
  expect([call?.[0](), call?.[1]]).toEqual([config, { surface: "gateway" }]);
}

export function writePersistedUpdateCheckState(state: PersistedUpdateCheckState): void {
  writeConfigMachineState(UPDATE_CHECK_STATE_KEY, { lastCheckedChannel: "stable", ...state });
}

export function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
  mockPackageInstallStatus();
  mockNpmChannelTag(tag, version);
}

export function mockPackageInstallStatus(root = "/opt/openclaw") {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
  vi.mocked(checkUpdateStatus).mockResolvedValue({
    root,
    installKind: "package",
    packageManager: "npm",
  } satisfies UpdateCheckResult);
}

export function mockNpmChannelTag(tag: string, version: string) {
  vi.mocked(resolveNpmChannelTag).mockResolvedValue({
    tag,
    version,
  });
  checkTelemetryUpdateMock.mockResolvedValue({ version });
}

export function mockDevGitStatus(params?: Parameters<typeof createDevGitStatus>[0]) {
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  const status = createDevGitStatus(params);
  vi.mocked(checkUpdateStatus).mockResolvedValue(status);
  return status;
}

export function createAutoUpdateSuccessMock() {
  return vi.fn().mockResolvedValue({
    status: "handoff",
  });
}

export function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
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

export function createBetaAutoUpdateConfig() {
  return {
    update: {
      channel: "beta" as const,
      auto: {
        enabled: true,
      },
    },
  };
}

export function createExtendedStableConfig(params?: { autoEnabled?: boolean }) {
  return {
    update: {
      channel: "extended-stable" as const,
      ...(params?.autoEnabled ? { auto: { enabled: true } } : {}),
    },
  };
}

export async function runExtendedStableUpdateCheck(
  params: Partial<Parameters<typeof runGatewayUpdateCheck>[0]> = {},
) {
  await runGatewayUpdateCheck({ cfg: createExtendedStableConfig(), ...params });
}

export async function seedExtendedStableAvailability(params?: {
  onUpdateAvailableChange?: Parameters<typeof runGatewayUpdateCheck>[0]["onUpdateAvailableChange"];
}) {
  mockPackageInstallStatus();
  mockNpmChannelTag("extended-stable", "2.0.0");
  await runExtendedStableUpdateCheck({
    onUpdateAvailableChange: params?.onUpdateAvailableChange,
  });
}

export function seedStableAutoRolloutState() {
  writePersistedUpdateCheckState({
    ...readPersistedUpdateCheckState(),
    autoInstallId: "stable-install-id",
    autoFirstSeenVersion: "3.0.0",
    autoFirstSeenTag: "latest",
    autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
  });
}

export function expectStableAutoRolloutStatePreserved() {
  expect(readPersistedUpdateCheckState()).toMatchObject({
    autoInstallId: "stable-install-id",
    autoFirstSeenVersion: "3.0.0",
    autoFirstSeenTag: "latest",
    autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
  });
}

export async function runAutoUpdateCheckWithDefaults(
  params: Parameters<typeof runGatewayUpdateCheck>[0],
) {
  await runGatewayUpdateCheck({ activeWorkInspectors: idleActiveWorkInspectors(), ...params });
  await clock.advanceBy(60_000);
}

export function setupUpdateStartupFixture() {
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
}

export {
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
};
