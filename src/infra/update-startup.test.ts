// Covers startup update check and auto-update behavior.
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
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
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import { UpdateCampaignController } from "./update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  currentUpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import type { AutoUpdateRunner } from "./update-startup-auto-run.js";
import {
  createDevGitStatus,
  writeDevGitInstallReceipt,
} from "./update-startup-git.test-support.js";
import {
  updateResult,
  matchingObject,
  containingObject,
  pauseAt,
  startedHandoff,
  idleActiveWorkInspectors,
  expectNoCalls,
} from "./update-startup-suite.test-support.js";

const {
  cancelManagedServiceUpdateHandoffMock: cancelHandoff,
  checkTelemetryUpdateMock: telemetry,
  detectRespawnSupervisorMock: supervisor,
  getRuntimeConfigMock: runtimeConfig,
  runUpdateFailureTriageMock: triage,
  refreshRemoteModelCatalogMock: refreshCatalog,
  scheduleGatewayRestartMock: restart,
  startManagedServiceUpdateHandoffMock: startHandoff,
  transferManagedServiceUpdateHandoffMock: transferHandoff,
  versionMock: versionRef,
} = await vi.hoisted(() => import("./update-startup.test-support.js"));

const UPDATE_CHECK_STATE_KEY = "update.checkState";

function commandSuccess(stdout = "") {
  return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" as const };
}

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

describe("update-startup", () => {
  let tempDir: string;
  let testState: OpenClawTestState;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let handoffTransferStarted: ReturnType<typeof createDeferred<void>>;
  let triageResult: Extract<Awaited<ReturnType<typeof triage>>, { status: "completed" }>;

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
  let autoRun: typeof import("./update-startup-auto-run.js");
  const updateChecks = new Set<ReturnType<typeof createGatewayUpdateCheck>>();

  type CheckOptions = {
    cfg: OpenClawConfig | (() => OpenClawConfig);
    log?: Parameters<typeof runGatewayUpdateCheckOwner>[0]["log"];
    isNixMode?: boolean;
  };
  type UpdateCheckFixtureParams = Omit<
    Parameters<typeof createGatewayUpdateCheck>[0],
    "getConfig" | "log" | "isNixMode" | "lifecycle" | "applyRemoteCatalogUpdate"
  > &
    CheckOptions & {
      applyRemoteCatalogUpdate?: Parameters<
        typeof createGatewayUpdateCheck
      >[0]["applyRemoteCatalogUpdate"];
    };
  function checkOptions<T extends CheckOptions>({
    cfg,
    log = { info: vi.fn() },
    isNixMode = false,
    ...params
  }: T) {
    return { ...params, log, isNixMode, getConfig: typeof cfg === "function" ? cfg : () => cfg };
  }
  function createTestUpdateCheck({
    applyRemoteCatalogUpdate = async () => "unchanged",
    ...params
  }: UpdateCheckFixtureParams) {
    const check = createGatewayUpdateCheck({
      ...checkOptions(params),
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
    allowInTests = true,
    ...params
  }: Omit<Parameters<typeof runGatewayUpdateCheckOwner>[0], "getConfig" | "log" | "isNixMode"> &
    CheckOptions) {
    return runGatewayUpdateCheckOwner({ ...checkOptions(params), allowInTests });
  }

  function readPersistedUpdateCheckState(): PersistedUpdateCheckState | null {
    return readConfigMachineState<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? null;
  }

  function expectLastTelemetryConfig(config: OpenClawConfig) {
    const call = telemetry.mock.lastCall;
    expect(call?.[0]()).toEqual(config);
  }

  function writePersistedUpdateCheckState(state: PersistedUpdateCheckState): void {
    writeConfigMachineState(UPDATE_CHECK_STATE_KEY, { lastCheckedChannel: "stable", ...state });
  }

  beforeEach(async () => {
    versionRef.value = "1.0.0";
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
    triage.mockReset().mockResolvedValue(triageResult);

    // Perf: load mocked modules once (after clock/env are set up).
    if (!loaded) {
      autoRun = await import("./update-startup-auto-run.js");
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
    telemetry.mockReset().mockResolvedValue(null);
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockReset().mockResolvedValue(commandSuccess());
    runtimeConfig.mockReset();
    runtimeConfig.mockReturnValue({});
    refreshCatalog.mockReset().mockResolvedValue({
      status: "unchanged",
      providers: 1,
      models: 1,
      generatedAt: 1_753_500_000_000,
    });
    supervisor.mockReset();
    supervisor.mockReturnValue(null);
    restart.mockClear();
    startHandoff.mockClear();
    handoffTransferStarted = createDeferred();
    transferHandoff.mockReset().mockImplementation(async () => {
      handoffTransferStarted.resolve();
      return true;
    });
    cancelHandoff.mockReset().mockResolvedValue("restored-in-process");
    startHandoff.mockResolvedValue(startedHandoff());
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

  it("retries install identity initialization after a failed probe", async () => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockRejectedValueOnce(new Error("probe failed"));

    await expect(getUpdateEffectiveChannel()).rejects.toThrow("probe failed");

    mockPackageInstallStatus();
    await expect(getUpdateEffectiveChannel()).resolves.toBe("stable");
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("coalesces configless Git identity before the schedule cache is ready", async ({ signal }) => {
    const entered = createDeferred();
    const probe = createDeferred<UpdateCheckResult>();
    const status = createDevGitStatus({ behind: 0, fetchOk: false });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockImplementationOnce(pauseAt(entered, probe));

    const first = getUpdateEffectiveChannel();
    const second = getUpdateEffectiveChannel();
    const channels = Promise.all([first, second]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, channels, "install discovery did not start"),
        signal,
      );
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      probe.resolve(status);

      await expect(channels).resolves.toEqual(["dev", "dev"]);
      await expect(getUpdateEffectiveChannel()).resolves.toBe("dev");
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    } finally {
      probe.resolve(status);
      await Promise.allSettled([channels]);
    }
  });

  function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
    mockPackageInstallStatus();
    mockNpmChannelTag(tag, version);
  }

  function mockPackageInstallStatus(root = "/opt/openclaw") {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    const status = {
      root,
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult;
    vi.mocked(checkUpdateStatus).mockResolvedValue(status);
    return status;
  }

  function mockNpmChannelTag(tag: string, version: string) {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag, version });
    telemetry.mockResolvedValue({ version });
  }

  function mockDevGitStatus(params?: Parameters<typeof createDevGitStatus>[0]) {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    const status = createDevGitStatus(params);
    vi.mocked(checkUpdateStatus).mockResolvedValue(status);
    return status;
  }

  function mockAutoUpdate(implementation: AutoUpdateRunner = async () => ({ status: "handoff" })) {
    const run = vi.fn(implementation);
    vi.spyOn(autoRun, "runAutoUpdateCommand").mockImplementation((params) => run(params));
    return run;
  }

  function autoConfig(channel: "stable" | "beta" | "dev" = "beta"): OpenClawConfig {
    return { update: { channel, auto: { enabled: true } } };
  }

  function checkAutomatically(
    cfg: CheckOptions["cfg"],
    params: Partial<Parameters<typeof runGatewayUpdateCheck>[0]> = {},
  ) {
    return runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      ...params,
    });
  }

  function observeTerminalSentinels() {
    const sentinels: Array<ReturnType<typeof readRestartSentinel>> = [];
    return {
      sentinels,
      onUpdateScheduleChange: (
        schedule: Parameters<
          NonNullable<Parameters<typeof runGatewayUpdateCheck>[0]["onUpdateScheduleChange"]>
        >[0],
      ) => {
        if (!schedule.campaign) {
          // The observer outlives the campaign job publishing its terminal schedule.
          sentinels.push(runOutsideAsyncWorkScope(() => readRestartSentinel()));
        }
      },
    };
  }

  function createExtendedStableConfig(params?: { autoEnabled?: boolean }) {
    return {
      update: {
        channel: "extended-stable" as const,
        ...(params?.autoEnabled ? { auto: { enabled: true } } : {}),
      },
    };
  }

  async function runExtendedStableUpdateCheck(
    params: Partial<Parameters<typeof runGatewayUpdateCheck>[0]> = {},
  ) {
    await runGatewayUpdateCheck({ cfg: createExtendedStableConfig(), ...params });
  }

  async function seedExtendedStableAvailability(params?: {
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
  }) {
    mockPackageInstallStatus();
    mockNpmChannelTag("extended-stable", "2.0.0");
    await runExtendedStableUpdateCheck({
      onUpdateAvailableChange: params?.onUpdateAvailableChange,
    });
  }

  function seedStableAutoRolloutState() {
    writePersistedUpdateCheckState({
      ...readPersistedUpdateCheckState(),
      ...stableRolloutState,
    });
  }

  const stableRolloutState = {
    autoInstallId: "stable-install-id",
    autoFirstSeenVersion: "3.0.0",
    autoFirstSeenTag: "latest",
    autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
  };

  function expectStableAutoRolloutStatePreserved() {
    expect(readPersistedUpdateCheckState()).toMatchObject(stableRolloutState);
  }

  async function runAutoUpdateCheckWithDefaults(
    params: Parameters<typeof runGatewayUpdateCheck>[0],
  ) {
    await checkAutomatically(params.cfg, params);
    await clock.advanceBy(60_000);
  }

  async function withScheduledBetaCampaign(
    params: {
      started: Promise<unknown>;
      signal: AbortSignal;
      release: () => void;
      log?: CheckOptions["log"];
    },
    inspect: (stop: () => Promise<void>) => Promise<void>,
  ) {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    supervisor.mockReturnValue("systemd");
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: autoConfig(),
      log: params.log,
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    let applying: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await clock.advanceBy(0);
      applying = clock.advanceBy(60_000);
      await withinTest(params.started, params.signal);
      await inspect(stop);
    } finally {
      params.release();
      await Promise.all([applying, stop()]);
    }
  }

  it("appends a bounded, terminal-safe remote note to the automatic update notice", async () => {
    mockPackageInstallStatus();
    telemetry.mockResolvedValue({
      version: "2.0.0",
      note: `\u001b[2KImportant\nnotice ${"x".repeat(600)}`,
    });
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({ cfg: {}, log });

    const message = log.info.mock.calls[0]?.[0];
    expect(message).toContain("Note: Important\\nnotice ");
    expect(message).not.toContain("\u001b");
    expect(message?.split("Note: ")[1]).toHaveLength(500);
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  });

  it("does not throttle invalid update-check clocks against persisted state", async () => {
    writePersistedUpdateCheckState({ lastCheckedAt: "2026-01-17T09:30:00.000Z" });
    mockPackageUpdateStatus("latest", "2.0.0");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    await runGatewayUpdateCheck({ cfg: { update: { channel: "stable" } } });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastCheckedAt: "1970-01-01T00:00:00.000Z",
      lastAvailableVersion: "2.0.0",
    });
  });

  it.each([
    { channel: "stable" as const, persistedTag: undefined, expectedTag: "latest" },
    { channel: "beta" as const, persistedTag: "latest", expectedTag: "latest" },
  ])(
    "hydrates $channel cached availability from its compatible $expectedTag tag",
    async ({ channel, persistedTag, expectedTag }) => {
      writePersistedUpdateCheckState({
        lastCheckedAt: new Date(Date.now()).toISOString(),
        lastCheckedChannel: channel,
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: persistedTag,
      });
      mockPackageInstallStatus();
      const onUpdateAvailableChange = vi.fn();

      await runGatewayUpdateCheck({ cfg: { update: { channel } }, onUpdateAvailableChange });

      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      expect(resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: expectedTag,
      });
    },
  );

  it("emits an update change when a previously available version becomes current", async () => {
    mockPackageInstallStatus();
    telemetry
      .mockResolvedValueOnce({ version: "2.0.0" })
      .mockResolvedValueOnce({ version: "1.0.0" });
    const onUpdateAvailableChange = vi.fn();
    const params = { cfg: { update: { channel: "stable" as const } }, onUpdateAvailableChange };
    await runGatewayUpdateCheck(params);
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runGatewayUpdateCheck(params);
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("closes a real Gateway registry request before the exact-package lookup", async ({
    signal,
  }) => {
    vi.useRealTimers();
    mockPackageInstallStatus();
    const selectorSeen = createDeferred();
    const selectorClosed = createDeferred<boolean>();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/openclaw/extended-stable") {
        response.on("close", () => selectorClosed.resolve(response.writableEnded));
        response.setHeader("content-type", "application/json");
        // Keep the selector body unfinished. Normal response completion must
        // never be mistaken for cancellation of the active registry fetch.
        response.write('{"version":"');
        selectorSeen.resolve();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: "2026.6.33" }));
    });
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () => server,
    });
    const controller = new AbortController();
    try {
      vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", "openclaw");
      vi.stubEnv("NPM_CONFIG_REGISTRY", `http://127.0.0.1:${reservation.claim.port}/`);
      const real = await vi.importActual<typeof import("./update-check.js")>("./update-check.js");
      vi.mocked(resolveNpmChannelTag).mockImplementation(real.resolveNpmChannelTag);
      const checking = runGatewayUpdateCheck({
        cfg: createExtendedStableConfig(),
        signal: controller.signal,
      });
      await withinTest(
        awaitGateBeforeSettlement(selectorSeen.promise, checking, "selector request did not start"),
        signal,
      );
      controller.abort();
      await expect(withinTest(checking, signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(await withinTest(selectorClosed.promise, signal)).toBe(false);
      expect(requests).toEqual(["/openclaw/extended-stable"]);
      expect(getUpdateAvailable()).toBeNull();
    } finally {
      controller.abort();
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await reservation.releaseListener();
      await reservation.claim.release();
    }
  });

  it("discovers and deduplicates an exact extended-stable update without auto-applying", async () => {
    const onUpdateAvailableChange = vi.fn();
    const runAutoUpdate = mockAutoUpdate();
    mockPackageUpdateStatus("extended-stable", "2.0.0");
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
    });
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
    });

    expect(telemetry).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledExactlyOnceWith({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "extended-stable",
    });
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastNotifiedVersion: "2.0.0",
      lastNotifiedTag: "extended-stable",
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expectNoCalls(runAutoUpdate, startHandoff, restart);
    expect(readPersistedUpdateCheckState()?.autoFirstSeenVersion).toBeUndefined();
  });

  it("clears stale extended-stable availability when exact selector resolution fails", async () => {
    const onUpdateAvailableChange = vi.fn();
    await seedExtendedStableAvailability({ onUpdateAvailableChange });
    seedStableAutoRolloutState();
    onUpdateAvailableChange.mockClear();
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "extended-stable", version: null });
    clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });

    expect(log.info).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()?.lastAvailableVersion).toBeUndefined();
    expect(readPersistedUpdateCheckState()?.lastCheckedChannel).toBe("extended-stable");
    expectStableAutoRolloutStatePreserved();
    expectNoCalls(startHandoff, restart);

    const lookupCount = vi.mocked(resolveNpmChannelTag).mock.calls.length;
    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });
    expect(resolveNpmChannelTag).toHaveBeenCalledTimes(lookupCount);
  });

  it("does not resolve the npm channel for an extended-stable Git install", async () => {
    await seedExtendedStableAvailability();
    seedStableAutoRolloutState();
    resetUpdateAvailableStateForTest(scheduler);
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "unknown",
    } satisfies UpdateCheckResult);
    const runAutoUpdate = mockAutoUpdate();
    const onUpdateAvailableChange = vi.fn();

    await runExtendedStableUpdateCheck({ onUpdateAvailableChange });

    expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    expectNoCalls(resolveNpmChannelTag, runAutoUpdate, onUpdateAvailableChange);
    expect(getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expectStableAutoRolloutStatePreserved();
  });

  it("skips all extended-stable work in Nix mode", async () => {
    const runAutoUpdate = mockAutoUpdate();

    await runExtendedStableUpdateCheck({ isNixMode: true });

    expectNoCalls(
      resolveOpenClawPackageRoot,
      checkUpdateStatus,
      resolveNpmChannelTag,
      telemetry,
      runAutoUpdate,
    );
    expect(readPersistedUpdateCheckState()).toBeNull();
  });

  it("announces and applies a dev git campaign without consulting npm", async () => {
    writeDevGitInstallReceipt({
      status: "error",
      ts: Date.now() - 60_000,
      reason: "managed-service-handoff-failed",
    });
    mockDevGitStatus({
      branch: "HEAD",
      repositoryUrl: "https://github.com/example/openclaw",
    });
    const longSubject = "x".repeat(140);
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce(
      commandSuccess(
        [
          `aaaaaaa\t${longSubject}`,
          "bbbbbbb\tSecond commit",
          "ccccccc\tThird commit",
          "ddddddd\tFourth commit",
          "eeeeeee\tFifth commit",
          "fffffff\tUnexpected sixth commit",
        ].join("\n"),
      ),
    );
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "dev", version: "99.0.0-dev.1" });
    const runAutoUpdate = mockAutoUpdate();

    await checkAutomatically(autoConfig("dev"));

    expect(checkUpdateStatus).toHaveBeenCalledWith({
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
      gitSourceHint: expect.objectContaining({
        root: "/opt/openclaw",
        sha: "current-sha",
        upstreamRef: "origin/main",
      }),
    });
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      channel: "dev",
      currentSha: "current-sha",
      upstreamRef: "origin/main",
      upstreamSha: "upstream-sha",
      repositoryUrl: "https://github.com/example/openclaw",
      commitsBehind: 2,
      commits: [
        { sha: "aaaaaaa", subject: "x".repeat(120) },
        { sha: "bbbbbbb", subject: "Second commit" },
        { sha: "ccccccc", subject: "Third commit" },
        { sha: "ddddddd", subject: "Fourth commit" },
        { sha: "eeeeeee", subject: "Fifth commit" },
      ],
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runAutoUpdate).not.toHaveBeenCalled();

    await clock.advanceBy(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      runId: listUpdateRuns()[0]?.runId,
      signal: expect.any(AbortSignal),
      channel: "dev",
      mode: "git",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "upstream-sha" },
    });
  });

  it("pins managed dev campaign handoffs to the announced commit", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    supervisor.mockReturnValue("launchd");
    const onUpdateRunCreated = vi.fn();

    await checkAutomatically(autoConfig("dev"), { onUpdateRunCreated });
    await clock.advanceBy(60_000);
    await handoffTransferStarted.promise;

    const [handoffParams] = startHandoff.mock.calls[0] ?? [];
    const run = getUpdateRun(handoffParams!.meta!.runId!);
    expect(run).toMatchObject({
      trigger: "campaign",
      status: "running",
      origin: { campaignId: getUpdateSchedule()?.campaign?.id },
      target: { kind: "git", sha: "frozen-upstream-sha" },
    });
    expect(onUpdateRunCreated).toHaveBeenCalledOnce();
    expect(handoffParams?.devTarget).toEqual({
      mode: "tracked",
      upstreamRef: "origin/main",
      upstreamSha: "frozen-upstream-sha",
    });
    expect(handoffParams?.timeoutMs).toBeUndefined();
    expect(transferHandoff).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it("records an already-current dev campaign without restarting or triage", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    const reason = "already-current";
    mockAutoUpdate(async () => ({
      status: "skipped",
      result: updateResult({ status: "skipped", mode: "git", reason, durationMs: 1 }),
      message: "The selected version is already current.",
    }));
    const { sentinels: terminalSentinels, onUpdateScheduleChange } = observeTerminalSentinels();
    await runAutoUpdateCheckWithDefaults({
      cfg: autoConfig("dev"),
      onUpdateScheduleChange,
    });
    expectNoCalls(startHandoff, transferHandoff, restart);
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(listUpdateRuns()).toEqual(
      matchingObject({
        trigger: "campaign",
        status: "skipped",
        reason,
        phase: "finished",
      }),
    );
    expect((await terminalSentinels.at(-1))?.payload).toMatchObject({
      kind: "update",
      status: "skipped",
      stats: { reason },
      message: expect.stringContaining("already current"),
    });
    expect(triage).not.toHaveBeenCalled();
  });

  it("reports current checkout metadata from its matching receipt", async () => {
    const installedAtMs = Date.now() - 60 * 60 * 1000;
    const commitAtMs = installedAtMs - 24 * 60 * 60 * 1000;
    writeDevGitInstallReceipt({ status: "ok", ts: installedAtMs });
    mockDevGitStatus({ behind: 0, commitAtMs });
    await runGatewayUpdateCheck({ cfg: { update: { channel: "dev" } } });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()?.install).toEqual({
      kind: "git",
      git: {
        status: "current",
        currentSha: "current-sha",
        upstreamSha: "upstream-sha",
        commitAtMs,
        installedAtMs,
      },
    });
  });

  it.each([
    {
      name: "failed fetch",
      git: { fetchOk: false, ahead: null, behind: null },
      expected: { status: "unavailable", reason: "fetch-failed" },
    },
    {
      name: "diverged checkout",
      git: { ahead: 1, behind: 3 },
      expected: {
        status: "diverged",
        upstreamSha: "upstream-sha",
        commitsAhead: 1,
        commitsBehind: 3,
      },
    },
  ])("reports $name without fabricating current", async ({ git, expected }) => {
    mockDevGitStatus(git);

    await runGatewayUpdateCheck({ cfg: autoConfig("dev") });

    expect(getUpdateSchedule()?.install?.git).toEqual({ currentSha: "current-sha", ...expected });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
  });

  it("keeps a new dev target visible during the automatic attempt cooldown", async () => {
    writePersistedUpdateCheckState({
      autoLastAttemptVersion: "upstream-one",
      autoLastAttemptAt: new Date(Date.now()).toISOString(),
    });
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    const runAutoUpdate = mockAutoUpdate();
    const cfg = autoConfig("dev");

    await checkAutomatically(cfg);

    expect(getUpdateAvailable()).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(runAutoUpdate).not.toHaveBeenCalled();

    clock.setTime(Date.now() + 60 * 60 * 1000 + 1);
    await checkAutomatically(cfg);

    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runAutoUpdate).not.toHaveBeenCalled();
    await clock.advanceBy(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "dev",
        devTarget: expect.objectContaining({ upstreamSha: "upstream-two" }),
      }),
    );
  });

  it("joins failed initialization and manual discovery before start", async ({ signal }) => {
    const status = mockDevGitStatus();
    const initial = createDeferred<UpdateCheckResult>();
    const remote = createDeferred<UpdateCheckResult>();
    const initialEntered = createDeferred();
    const remoteEntered = createDeferred();
    vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit }) => {
      (fetchGit ? remoteEntered : initialEntered).resolve();
      return fetchGit ? remote.promise : initial.promise;
    });
    const check = createTestUpdateCheck({ cfg: { update: { channel: "dev" } } });
    const initializing = check.initialize().catch((error: unknown) => error);
    const refreshing = refreshGatewayUpdateStatus(() => ({ update: { channel: "dev" } })).catch(
      (error: unknown) => error,
    );
    let stopped = false;
    try {
      await withinTest(Promise.all([initialEntered.promise, remoteEntered.promise]), signal);
      expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
      const signals = vi.mocked(checkUpdateStatus).mock.calls.map(([options]) => options.signal);
      expect(signals.every((discoverySignal) => discoverySignal && !discoverySignal.aborted)).toBe(
        true,
      );
      const stopping = check.stop().then(() => {
        stopped = true;
      });
      expect(signals.every((discoverySignal) => discoverySignal?.aborted)).toBe(true);
      initial.reject(new Error("synthetic discovery failure"));
      await initializing;
      expect(stopped).toBe(false);
      remote.resolve(status);
      await refreshing;
      await stopping;
      expect(getUpdateSchedule()).toBeNull();
      await expect(getUpdateEffectiveChannel()).rejects.toMatchObject({ name: "AbortError" });
      check.start();
      await clock.advanceBy(0);
      expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
      expect(refreshCatalog).not.toHaveBeenCalled();
    } finally {
      initial.resolve(status);
      remote.resolve(status);
      await Promise.all([initializing, refreshing, check.stop()]);
    }
  });

  it("inherits predecessor discovery draining when a replacement stops before start", async ({
    signal,
  }) => {
    const status = mockDevGitStatus();
    const remote = createDeferred<UpdateCheckResult>();
    const entered = createDeferred();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(pauseAt(entered, remote));
    const params = {
      cfg: { update: { channel: "dev" as const } },
      log: { info: vi.fn() },
      isNixMode: false,
    };
    createTestUpdateCheck(params);
    const oldRefresh = refreshGatewayUpdateStatus(() => params.cfg);
    expect(refreshGatewayUpdateStatus(() => params.cfg)).toBe(oldRefresh);
    const refreshing = oldRefresh.catch((error: unknown) => error);
    let initializing: Promise<unknown> | undefined;
    let newRefreshing: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      const oldSignal = vi.mocked(checkUpdateStatus).mock.calls[0]?.[0].signal;
      const replacement = createTestUpdateCheck(params);
      initializing = replacement.initialize().catch((error: unknown) => error);
      const newRefresh = refreshGatewayUpdateStatus(() => params.cfg);
      expect(newRefresh).not.toBe(oldRefresh);
      expect(refreshGatewayUpdateStatus(() => params.cfg)).toBe(newRefresh);
      newRefreshing = newRefresh.catch((error: unknown) => error);
      let stopped = false;
      stopping = replacement.stop().then(() => {
        stopped = true;
      });
      expect(oldSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
      remote.resolve(status);
      await Promise.all([refreshing, initializing, newRefreshing, stopping]);
      expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
    } finally {
      remote.resolve(status);
      await Promise.all([refreshing, initializing, newRefreshing, stopping]);
    }
  });

  it("cancels and joins a commit summary read before stopping discovery", async ({ signal }) => {
    mockDevGitStatus();
    process.env.NODE_ENV = "production";
    const logRead = createDeferred<Awaited<ReturnType<typeof runCommandWithTimeout>>>();
    const entered = createDeferred();
    vi.mocked(runCommandWithTimeout).mockImplementationOnce(pauseAt(entered, logRead));
    const onUpdateAvailableChange = vi.fn();
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      onUpdateAvailableChange,
    });
    let stopped = false;
    const result = commandSuccess("abc123\tsynthetic commit\n");
    const checking = clock.advanceBy(0);
    try {
      await withinTest(entered.promise, signal);
      const [argv, options] = vi.mocked(runCommandWithTimeout).mock.calls[0] ?? [];
      expect(argv).toContain("log");
      const discoverySignal = typeof options === "object" ? options.signal : undefined;
      const stopping = stop().then(() => {
        stopped = true;
      });
      expect(discoverySignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      logRead.resolve(result);
      await stopping;
      expect(onUpdateAvailableChange).not.toHaveBeenCalled();
    } finally {
      logRead.resolve(result);
      await Promise.all([checking, stop()]);
    }
  });

  it("schedules enabled dev git checks hourly", async () => {
    mockDevGitStatus();
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: autoConfig("dev"),
    });
    await clock.advanceBy(0);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    await clock.advanceBy(60 * 60 * 1000 - 1);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    await clock.advanceBy(1);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(3);
    await stop();
  });

  it("uses current config for scheduled update and catalog checks", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.NODE_ENV = "production";
    let cfg: OpenClawConfig = { update: { channel: "beta" } };
    scheduleGatewayUpdateCheck({ cfg: () => cfg });
    await clock.advanceBy(0);
    expect(getUpdateSchedule()?.channel).toBe("beta");

    cfg = {
      update: { channel: "stable" },
      telemetry: { enabled: false },
      models: { catalogRefresh: { enabled: false } },
    };
    await clock.advanceBy(6 * 60 * 60_000);
    expect(refreshCatalog).toHaveBeenLastCalledWith({
      config: cfg,
      signal: expect.any(AbortSignal),
    });
    await clock.advanceBy(18 * 60 * 60_000);
    expect(getUpdateSchedule()?.channel).toBe("stable");
    expectLastTelemetryConfig(cfg);
  });

  it("reads telemetry consent after awaited install discovery", async ({ signal }) => {
    const status = mockPackageInstallStatus();
    const discovery = createDeferred<UpdateCheckResult>();
    const entered = createDeferred();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(pauseAt(entered, discovery));
    let cfg: OpenClawConfig = { telemetry: { enabled: true } };
    const params = {
      cfg: () => cfg,
    };
    const checking = runGatewayUpdateCheck(params);
    try {
      await withinTest(entered.promise, signal);
      cfg = { telemetry: { enabled: false } };
      discovery.resolve(status);
      await checking;

      expect(telemetry).toHaveBeenCalledOnce();
      expectLastTelemetryConfig(cfg);
    } finally {
      discovery.resolve(status);
      await checking;
    }
  });

  it.each([
    { channel: "beta", change: "auto-disabled" },
    { channel: "beta", change: "checks-disabled" },
    { channel: "beta", change: "channel-changed" },
  ] as const)(
    "rechecks $channel countdown admission after $change",
    async ({ channel, change }) => {
      mockPackageUpdateStatus("beta", "2.0.0-beta.1");
      let cfg: OpenClawConfig = { update: { channel, auto: { enabled: true } } };
      const runAutoUpdate = mockAutoUpdate();
      const params = {
        cfg: () => cfg,
        activeWorkInspectors: idleActiveWorkInspectors(),
      };
      await runGatewayUpdateCheck(params);
      expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
      cfg = {
        update: {
          channel: change === "channel-changed" ? "stable" : channel,
          checkOnStart: change !== "checks-disabled",
          auto: { enabled: change !== "auto-disabled" },
        },
      };
      await clock.advanceBy(60_000);

      expect(runAutoUpdate).not.toHaveBeenCalled();
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      expect(readPersistedUpdateCheckState()?.autoLastAttemptAt).toBeUndefined();
      expect(await readRestartSentinel()).toBeNull();
    },
  );

  it("preserves an applying campaign after update checks are disabled", async ({ signal }) => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const applying = createDeferred<{ status: "handoff" }>();
    const entered = createDeferred();
    mockAutoUpdate(pauseAt(entered, applying));
    let cfg = autoConfig();
    const params = {
      cfg: () => cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
    };
    let applyingWake: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await runGatewayUpdateCheck(params);
      applyingWake = clock.advanceBy(60_000);
      await withinTest(entered.promise, signal);
      const admitted = getUpdateSchedule()?.campaign;
      expect(admitted?.state).toBe("applying");
      cfg = { update: { checkOnStart: false } };
      await runGatewayUpdateCheck(params);
      expect(getUpdateSchedule()?.campaign).toEqual(admitted);
    } finally {
      applying.resolve({ status: "handoff" });
      await applyingWake;
    }
  });

  it("drains stopped discovery before a replacement scheduler", async ({ signal }) => {
    const oldGitStatus = mockDevGitStatus({ upstreamSha: "old-upstream" });
    const entered = createDeferred();
    const oldFetch = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus)
      .mockResolvedValueOnce(oldGitStatus)
      .mockImplementationOnce(pauseAt(entered, oldFetch));
    process.env.NODE_ENV = "production";
    const onOldSchedule = vi.fn();
    const onOldAvailable = vi.fn();
    const stopOld = scheduleGatewayUpdateCheck({
      cfg: autoConfig("dev"),
      activeWorkInspectors: idleActiveWorkInspectors(),
      onUpdateScheduleChange: onOldSchedule,
      onUpdateAvailableChange: onOldAvailable,
    });
    const checking = clock.advanceBy(0);
    let stopReplacement: (() => Promise<void>) | undefined;
    let replacementChecking: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await withinTest(entered.promise, signal);
      const stoppingOld = stopOld();
      mockDevGitStatus({ upstreamSha: "new-upstream", behind: 3 });
      stopReplacement = scheduleGatewayUpdateCheck({
        cfg: autoConfig("dev"),
        activeWorkInspectors: idleActiveWorkInspectors(),
      });
      replacementChecking = clock.advanceBy(0);
      await Promise.resolve();
      expect(checkUpdateStatus).toHaveBeenCalledTimes(2);

      oldFetch.resolve(oldGitStatus);
      await Promise.all([checking, stoppingOld, replacementChecking]);

      expectNoCalls(onOldSchedule, onOldAvailable);
      expect(getUpdateSchedule()?.channel).toBe("dev");
      expect(getUpdateAvailable()?.upstreamSha).toBe("new-upstream");
    } finally {
      oldFetch.resolve(oldGitStatus);
      await Promise.all([checking, replacementChecking, stopOld(), stopReplacement?.()]);
    }
  });

  it.for([
    { channel: "beta", joined: true, cancelled: "restored-in-process" as const },
    { channel: "beta", joined: false, cancelled: false as const },
  ])(
    "reconciles a late $channel handoff after stop with joined=$joined and cancellation=$cancelled",
    async ({ joined, cancelled }, { signal }) => {
      cancelHandoff.mockResolvedValueOnce(cancelled);
      const entered = createDeferred();
      let releaseHandoff!: () => void;
      startHandoff.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            entered.resolve();
            releaseHandoff = () => {
              const handoff = startedHandoff({
                logPath: "/tmp/late-handoff.log",
                handoffId: "late-handoff",
              });
              resolve(
                joined ? { ...handoff, status: "joined" } : { ...handoff, status: "started" },
              );
            };
          }),
      );
      const log = { info: vi.fn() };
      await withScheduledBetaCampaign(
        { started: entered.promise, signal, release: () => releaseHandoff?.(), log },
        async (stop) => {
          expect(releaseHandoff).toEqual(expect.any(Function));
          let stopped = false;
          const stopping = stop().then(() => {
            stopped = true;
          });
          await Promise.resolve();
          expect(stopped).toBe(false);
          releaseHandoff();
          await stopping;
          if (joined) {
            expect(cancelHandoff).not.toHaveBeenCalled();
          } else {
            expect(cancelHandoff).toHaveBeenCalledWith({
              kind: "managed-update-handoff",
              handoffId: "late-handoff",
              installRoot: "/opt/openclaw",
            });
            if (cancelled !== "restored-in-process") {
              expect(log.info).toHaveBeenCalledWith(
                "stopped auto-update handoff cancellation could not be verified",
                expect.objectContaining({ result: cancelled, logPath: "/tmp/late-handoff.log" }),
              );
            }
          }
          expectNoCalls(restart, transferHandoff);
          expect(await readRestartSentinel()).toBeNull();
          expect(triage).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("does not publish triage from a stopped scheduler over a newer restart", async ({
    signal,
  }) => {
    startHandoff.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const entered = createDeferred();
    const pendingTriage = createDeferred<typeof triageResult>();
    triage.mockImplementationOnce(pauseAt(entered, pendingTriage));
    await withScheduledBetaCampaign(
      { started: entered.promise, signal, release: () => pendingTriage.resolve(triageResult) },
      async (stop) => {
        expect(triage).toHaveBeenCalledOnce();
        const stopping = stop();
        await writeRestartSentinel({
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          message: "newer restart",
        });
        const newer = await readRestartSentinel();
        pendingTriage.resolve(triageResult);
        await stopping;
        expect(await readRestartSentinel()).toEqual(newer);
        expect(restart).not.toHaveBeenCalled();
        expect(triage).toHaveBeenCalledOnce();
      },
    );
  });

  it("joins and cancels an ownership transfer that completes after scheduler stop", async ({
    signal,
  }) => {
    const transferred = createDeferred<boolean>();
    transferHandoff.mockImplementationOnce(pauseAt(handoffTransferStarted, transferred));
    await withScheduledBetaCampaign(
      { started: handoffTransferStarted.promise, signal, release: () => transferred.resolve(true) },
      async (stop) => {
        expect(transferHandoff).toHaveBeenCalledOnce();
        let stopped = false;
        const stopping = stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(restart).not.toHaveBeenCalled();
        transferred.resolve(true);
        await stopping;
        expect(cancelHandoff).toHaveBeenCalledExactlyOnceWith({
          kind: "managed-update-handoff",
          handoffId: "auto-handoff-id",
          installRoot: "/opt/openclaw",
        });
        expect(await readRestartSentinel()).toBeNull();
        expect(triage).not.toHaveBeenCalled();
      },
    );
  });

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = mockAutoUpdate();
    const stableAutoConfig = autoConfig("stable");

    await checkAutomatically(stableAutoConfig);
    expect(runAutoUpdate).not.toHaveBeenCalled();

    clock.setTime(Date.parse("2026-01-18T07:00:00Z"));
    await checkAutomatically(stableAutoConfig);
    await clock.advanceBy(60_000);

    expect(runAutoUpdate).toHaveBeenCalledExactlyOnceWith({
      channel: "stable",
      runId: listUpdateRuns()[0]?.runId,
      signal: expect.any(AbortSignal),
      mode: "npm",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      packageTargetVersion: "2.0.0",
    });
  });

  it("ends a held stable campaign when its replacement target is not yet due", async () => {
    const campaign = new UpdateCampaignController(scheduler);
    currentUpdateCheckLifecycle().campaign = campaign;
    const runAutoUpdate = mockAutoUpdate();
    const cfg = autoConfig("stable");
    mockPackageUpdateStatus("latest", "2.0.0");
    writePersistedUpdateCheckState({
      autoInstallId: "stable-held-install",
      autoFirstSeenVersion: "2.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    });
    const check = () => checkAutomatically(cfg);

    try {
      await check();
      expect(campaign.hold()).toBe(true);
      clock.setTime(Date.now() + 60 * 60_000);
      mockNpmChannelTag("latest", "3.0.0");

      await check();

      expect(getUpdateSchedule()?.target).toEqual({ kind: "package", version: "3.0.0" });
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      await clock.advanceBy(65_000);
      expect(runAutoUpdate).not.toHaveBeenCalled();
    } finally {
      campaign.clear();
    }
  });

  it.each(["checkOnStart", "OPENCLAW_NO_AUTO_UPDATE"] as const)(
    "disables all automatic update traffic with %s",
    async (optOut) => {
      mockPackageUpdateStatus("beta", "2.0.0-beta.1");
      if (optOut === "OPENCLAW_NO_AUTO_UPDATE") {
        process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
      }
      const runAutoUpdate = mockAutoUpdate();
      const log = { info: vi.fn() };

      await runGatewayUpdateCheck({
        cfg: {
          update: {
            ...autoConfig().update,
            ...(optOut === "checkOnStart" ? { checkOnStart: false } : {}),
          },
        },
        log,
      });

      await clock.advanceBy(60_000);

      expect(log.info).not.toHaveBeenCalled();
      expect(readPersistedUpdateCheckState()).toBeNull();
      expectNoCalls(runAutoUpdate, telemetry, resolveNpmChannelTag, checkUpdateStatus);
      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()).toMatchObject({ channel: "beta", autoEnabled: false });
    },
  );

  it("keeps external auto-update supervision authoritative over native systemd markers", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    supervisor.mockReturnValue("systemd");
    const log = { info: vi.fn() };
    const runAutoUpdate = mockAutoUpdate();

    await runGatewayUpdateCheck({ cfg: autoConfig(), log });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("auto-update delegated to external supervisor", {
      version: "2.0.0-beta.1",
      tag: "beta",
      reason: "external-supervisor-update-required",
    });
  });

  it("keeps a foreground Gateway serving when automatic update has no restart owner", async () => {
    process.env.OPENCLAW_PROFILE = "work";
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    await runAutoUpdateCheckWithDefaults({ cfg: autoConfig() });

    expectNoCalls(runCommandWithTimeout, startHandoff, restart);
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(getUpdateAvailable()).toMatchObject({ latestVersion: "2.0.0-beta.1" });
    expect((await readRestartSentinel())?.payload).toMatchObject({
      kind: "update",
      status: "skipped",
      message: expect.stringMatching(
        /Stop the foreground Gateway.*`openclaw --profile work update --yes --channel beta --tag 2\.0\.0-beta\.1`.*then launch the Gateway again/s,
      ),
      stats: { reason: "managed-service-handoff-unavailable" },
    });
  });

  it("preserves a failed handoff when automatic triage fails", async () => {
    const helperPath = "/private/temporary-update-handoff/handoff.cjs";
    const startupError = Object.assign(
      new Error(`ENOENT: no such file or directory, open '${helperPath}'`),
      { code: "ENOENT", path: helperPath },
    );
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    supervisor.mockReturnValue("launchd");
    startHandoff.mockRejectedValueOnce(startupError);
    triage.mockResolvedValueOnce({
      status: "failed",
      hint: "Triage could not complete: collector failed. Run openclaw triage.",
    });
    const log = { info: vi.fn() };
    const { sentinels: terminalSentinels, onUpdateScheduleChange } = observeTerminalSentinels();

    await runGatewayUpdateCheck({
      cfg: autoConfig(),
      log,
      activeWorkInspectors: idleActiveWorkInspectors(),
      onUpdateScheduleChange,
    });
    await clock.advanceBy(60_000);

    expect(restart).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect((await terminalSentinels.at(-1))?.payload).toMatchObject({
      kind: "update",
      status: "error",
      doctorHint: expect.stringContaining("openclaw triage"),
      stats: { reason: "managed-service-handoff-failed" },
    });
    expect(triage).toHaveBeenCalledOnce();
    expect(JSON.stringify(triage.mock.calls[0]?.[0].failure)).not.toContain(helperPath);
    expect(JSON.stringify((await terminalSentinels.at(-1))?.payload)).not.toContain(helperPath);
    expect(listUpdateRuns()[0]).toMatchObject({
      target: { installationMethod: "managed-service" },
      verification: { rollbackOutcome: { status: "not-attempted" } },
      steps: containingObject({
        step: "managed-service",
        status: "failed",
        failureFacts: matchingObject({ check: "managed-service", code: "ENOENT" }),
      }),
    });
  });

  it("does not schedule another restart when auto-update joins an active handoff", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    supervisor.mockReturnValue("launchd");
    startHandoff.mockResolvedValueOnce({
      status: "joined",
      pid: 12345,
      command: "openclaw update --yes --channel beta",
      logPath: "/tmp/openclaw-handoff.log",
      handoffId: "handoff-existing",
    });

    await runAutoUpdateCheckWithDefaults({ cfg: autoConfig() });

    expectNoCalls(restart, transferHandoff, triage);
    expect(listUpdateRuns()).toEqual(
      matchingObject({
        trigger: "campaign",
        status: "skipped",
        reason: "managed-service-handoff-already-running",
        finishedAtMs: expect.any(Number),
      }),
    );
  });

  it("joins an aborted catalog refresh when it rejects", async ({ signal }) => {
    let capturedSignal: AbortSignal | undefined;
    const entered = createDeferred();
    const finished = createDeferred<Awaited<ReturnType<typeof refreshCatalog>>>();
    refreshCatalog.mockImplementationOnce(({ signal: catalogSignal }) => {
      capturedSignal = catalogSignal;
      entered.resolve();
      return finished.promise;
    });
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
    });

    let stopped = false;
    const checking = clock.advanceBy(0);
    try {
      await withinTest(entered.promise, signal);
      expect(capturedSignal?.aborted).toBe(false);
      const stopping = stop().then(() => {
        stopped = true;
      });
      expect(capturedSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      finished.reject(new Error("synthetic catalog cancellation"));
      await stopping;
    } finally {
      finished.resolve({ status: "error", error: "aborted", providers: 0, models: 0 });
      await Promise.all([checking, stop()]);
    }
  });

  it.each(["unchanged", "failed"] as const)(
    "uses the remaining stored TTL after a fresh startup check when adoption is %s",
    async (adoption) => {
      refreshCatalog.mockResolvedValueOnce({
        status: "fresh",
        providers: 1,
        models: 1,
        generatedAt: 1_753_500_000_000,
        nextCheckInMs: 1_000,
      });
      const info = vi.fn();
      const stop = scheduleGatewayUpdateCheck({
        cfg: { update: { channel: "extended-stable", checkOnStart: false } },
        log: { info },
        applyRemoteCatalogUpdate: async () => {
          if (adoption === "failed") {
            throw new SyntaxError("synthetic corrupt stored catalog");
          }
          return adoption;
        },
      });

      await clock.advanceBy(0);
      expect(refreshCatalog).toHaveBeenCalledTimes(1);
      if (adoption === "failed") {
        // A failed adoption retries with the stored catalog, not after a full TTL.
        expect(info).toHaveBeenCalledWith("remote model catalog check failed", {
          error: expect.stringContaining("SyntaxError"),
        });
      }
      await clock.advanceBy(999);
      expect(refreshCatalog).toHaveBeenCalledTimes(1);
      await clock.advanceBy(1);
      expect(refreshCatalog).toHaveBeenCalledTimes(2);
      await stop();
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
