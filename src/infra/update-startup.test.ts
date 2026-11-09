import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import { useUpdateStartupTestFixture } from "./update-startup-fixture.test-support.js";
import {
  createDevGitStatus,
  writeDevGitInstallReceipt,
} from "./update-startup-git.test-support.js";

const {
  checkTelemetryUpdateMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  versionMock,
} = await vi.hoisted(() => import("./update-startup.test-support.js"));

describe("update-startup", () => {
  const fixture = useUpdateStartupTestFixture();
  const {
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
  } = fixture;

  function expectLastTelemetryConfig(config: OpenClawConfig) {
    const call = checkTelemetryUpdateMock.mock.lastCall;
    expect([call?.[0](), call?.[1]]).toEqual([config, { surface: "gateway" }]);
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
      autoInstallId: "stable-install-id",
      autoFirstSeenVersion: "3.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
    });
  }

  function expectStableAutoRolloutStatePreserved() {
    expect(readPersistedUpdateCheckState()).toMatchObject({
      autoInstallId: "stable-install-id",
      autoFirstSeenVersion: "3.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: "2026-01-16T10:00:00.000Z",
    });
  }

  it("retries install identity initialization after a failed probe", async () => {
    vi.mocked(fixture.resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(fixture.checkUpdateStatus).mockRejectedValueOnce(new Error("probe failed"));

    await expect(fixture.getUpdateEffectiveChannel()).rejects.toThrow("probe failed");

    mockPackageInstallStatus();
    await expect(fixture.getUpdateEffectiveChannel()).resolves.toBe("stable");
    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("coalesces configless Git identity before the schedule cache is ready", async ({ signal }) => {
    const entered = createDeferred();
    const probe = createDeferred<UpdateCheckResult>();
    const status = createDevGitStatus({ behind: 0, fetchOk: false });
    vi.mocked(fixture.resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(fixture.checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return probe.promise;
    });

    const first = fixture.getUpdateEffectiveChannel();
    const second = fixture.getUpdateEffectiveChannel();
    const channels = Promise.all([first, second]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, channels, "install discovery did not start"),
        signal,
      );
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
      probe.resolve(status);

      await expect(channels).resolves.toEqual(["dev", "dev"]);
      await expect(fixture.getUpdateEffectiveChannel()).resolves.toBe("dev");
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
    } finally {
      probe.resolve(status);
      await Promise.allSettled([channels]);
    }
  });
  it("appends a bounded, terminal-safe remote note to the automatic update notice", async () => {
    mockPackageInstallStatus();
    checkTelemetryUpdateMock.mockResolvedValue({
      version: "2.0.0",
      note: `\u001b[2KImportant\nnotice ${"x".repeat(600)}`,
    });
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: {},
      log,
    });

    const message = log.info.mock.calls[0]?.[0];
    expect(message).toContain("Note: Important\\nnotice ");
    expect(message).not.toContain("\u001b");
    expect(message?.split("Note: ")[1]).toHaveLength(500);
    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
  });

  it("does not throttle invalid update-check clocks against persisted state", async () => {
    writePersistedUpdateCheckState({
      lastCheckedAt: "2026-01-17T09:30:00.000Z",
    });
    mockPackageUpdateStatus("latest", "2.0.0");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
    });

    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
    const parsed = readPersistedUpdateCheckState();
    expect(parsed?.lastCheckedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed?.lastAvailableVersion).toBe("2.0.0");
  });

  it.each([
    {
      channel: "stable" as const,
      persistedTag: undefined,
      expectedTag: "latest",
    },
    {
      channel: "beta" as const,
      persistedTag: "latest",
      expectedTag: "latest",
    },
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

      await runGatewayUpdateCheck({
        cfg: { update: { channel } },
        onUpdateAvailableChange,
      });

      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
      expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
      expect(onUpdateAvailableChange).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: expectedTag,
      });
    },
  );

  it("emits an update change when a previously available version becomes current", async () => {
    mockPackageInstallStatus();
    checkTelemetryUpdateMock
      .mockResolvedValueOnce({ version: "2.0.0" })
      .mockResolvedValueOnce({ version: "1.0.0" });
    const onUpdateAvailableChange = vi.fn();
    const params = { cfg: { update: { channel: "stable" as const } }, onUpdateAvailableChange };
    await runGatewayUpdateCheck(params);
    fixture.clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runGatewayUpdateCheck(params);
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(fixture.getUpdateAvailable()).toBeNull();
  });

  it("uses the exact selector for an installed final extended-stable package", async () => {
    versionMock.value = "2026.6.33";
    mockPackageUpdateStatus("extended-stable", "2026.7.33");
    const onUpdateAvailableChange = vi.fn();

    await runGatewayUpdateCheck({
      cfg: {},
      onUpdateAvailableChange,
    });

    expectLastTelemetryConfig({});
    expect(fixture.resolveNpmChannelTag).toHaveBeenCalledWith({
      channel: "extended-stable",
    });
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "2026.6.33",
      latestVersion: "2026.7.33",
      channel: "extended-stable",
    });
  });

  it("discovers and deduplicates an exact extended-stable update without auto-applying", async () => {
    const onUpdateAvailableChange = vi.fn();
    const runAutoUpdate = createAutoUpdateSuccessMock();
    mockPackageUpdateStatus("extended-stable", "2.0.0");
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });
    fixture.clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    await runExtendedStableUpdateCheck({
      cfg: createExtendedStableConfig({ autoEnabled: true }),
      log,
      onUpdateAvailableChange,
      runAutoUpdate,
    });

    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
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
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()?.autoFirstSeenVersion).toBeUndefined();
  });

  it("clears stale extended-stable availability when exact selector resolution fails", async () => {
    const onUpdateAvailableChange = vi.fn();
    await seedExtendedStableAvailability({ onUpdateAvailableChange });
    seedStableAutoRolloutState();
    onUpdateAvailableChange.mockClear();
    vi.mocked(fixture.resolveNpmChannelTag).mockResolvedValue({
      tag: "extended-stable",
      version: null,
    });
    fixture.clock.setTime(Date.parse("2026-01-18T11:00:00Z"));
    const log = { info: vi.fn() };

    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });

    expect(log.info).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledOnce();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith(null);
    expect(fixture.getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()?.lastAvailableVersion).toBeUndefined();
    expect(readPersistedUpdateCheckState()?.lastCheckedChannel).toBe("extended-stable");
    expectStableAutoRolloutStatePreserved();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();

    const lookupCount = vi.mocked(fixture.resolveNpmChannelTag).mock.calls.length;
    await runExtendedStableUpdateCheck({ log, onUpdateAvailableChange });
    expect(fixture.resolveNpmChannelTag).toHaveBeenCalledTimes(lookupCount);
  });

  it("does not resolve the npm channel for an extended-stable Git install", async () => {
    await seedExtendedStableAvailability();
    seedStableAutoRolloutState();
    fixture.resetUpdateAvailableStateForTest(fixture.scheduler);
    vi.mocked(fixture.resolveOpenClawPackageRoot).mockClear();
    vi.mocked(fixture.checkUpdateStatus).mockClear();
    vi.mocked(fixture.resolveNpmChannelTag).mockClear();
    vi.mocked(fixture.resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(fixture.checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "unknown",
    } satisfies UpdateCheckResult);
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const onUpdateAvailableChange = vi.fn();

    await runExtendedStableUpdateCheck({ onUpdateAvailableChange, runAutoUpdate });

    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).not.toHaveBeenCalled();
    expect(fixture.getUpdateAvailable()).toBeNull();
    expect(readPersistedUpdateCheckState()).toMatchObject({
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "extended-stable",
    });
    expectStableAutoRolloutStatePreserved();
  });

  it("skips all extended-stable work in Nix mode", async () => {
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runExtendedStableUpdateCheck({ isNixMode: true, runAutoUpdate });

    expect(fixture.resolveOpenClawPackageRoot).not.toHaveBeenCalled();
    expect(fixture.checkUpdateStatus).not.toHaveBeenCalled();
    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
  });

  it("reports current checkout metadata from its matching receipt", async () => {
    const installedAtMs = Date.now() - 60 * 60 * 1000;
    const commitAtMs = installedAtMs - 24 * 60 * 60 * 1000;
    writeDevGitInstallReceipt({ status: "ok", ts: installedAtMs });
    mockDevGitStatus({ behind: 0, commitAtMs });
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });
    expect(fixture.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(fixture.getUpdateAvailable()).toBeNull();
    expect(fixture.getUpdateSchedule()?.install).toEqual({
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
      name: "missing upstream",
      git: { upstream: null, upstreamSha: null, ahead: null, behind: null },
      expected: { status: "unavailable", reason: "no-upstream" },
    },
    {
      name: "missing configured upstream ref",
      git: {
        branch: "HEAD",
        upstream: "origin/missing",
        upstreamSha: null,
        ahead: null,
        behind: null,
      },
      expected: { status: "unavailable", reason: "no-upstream-sha" },
    },
    {
      name: "incomparable history",
      git: { ahead: null, behind: null },
      expected: { status: "unavailable", reason: "comparison-failed" },
    },
    {
      name: "ahead checkout",
      git: { ahead: 2, behind: 0 },
      expected: { status: "ahead", upstreamSha: "upstream-sha", commitsAhead: 2 },
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

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
    });

    expect(fixture.getUpdateSchedule()?.install?.git).toEqual({
      currentSha: "current-sha",
      ...expected,
    });
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
  });

  it("joins failed initialization and manual discovery before start", async ({ signal }) => {
    const status = mockDevGitStatus();
    const initial = createDeferred<UpdateCheckResult>();
    const remote = createDeferred<UpdateCheckResult>();
    const initialEntered = createDeferred();
    const remoteEntered = createDeferred();
    vi.mocked(fixture.checkUpdateStatus).mockImplementation(({ fetchGit }) => {
      (fetchGit ? remoteEntered : initialEntered).resolve();
      return fetchGit ? remote.promise : initial.promise;
    });
    const check = createTestUpdateCheck({
      cfg: { update: { channel: "dev" } },
    });
    const initializing = check.initialize().catch((error: unknown) => error);
    const refreshing = fixture
      .refreshGatewayUpdateStatus(() => ({ update: { channel: "dev" } }))
      .catch((error: unknown) => error);
    let stopped = false;
    try {
      await withinTest(Promise.all([initialEntered.promise, remoteEntered.promise]), signal);
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);
      const signals = vi
        .mocked(fixture.checkUpdateStatus)
        .mock.calls.map(([options]) => options.signal);
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
      expect(fixture.getUpdateSchedule()).toBeNull();
      await expect(fixture.getUpdateEffectiveChannel()).rejects.toMatchObject({
        name: "AbortError",
      });
      check.start();
      await fixture.clock.advanceBy(0);
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);
      expect(refreshRemoteModelCatalogMock).not.toHaveBeenCalled();
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
    vi.mocked(fixture.checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return remote.promise;
    });
    const params = {
      cfg: { update: { channel: "dev" as const } },
      log: { info: vi.fn() },
      isNixMode: false,
    };
    createTestUpdateCheck(params);
    const oldRefresh = fixture.refreshGatewayUpdateStatus(() => params.cfg);
    expect(fixture.refreshGatewayUpdateStatus(() => params.cfg)).toBe(oldRefresh);
    const refreshing = oldRefresh.catch((error: unknown) => error);
    let initializing: Promise<unknown> | undefined;
    let newRefreshing: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      const oldSignal = vi.mocked(fixture.checkUpdateStatus).mock.calls[0]?.[0].signal;
      const replacement = createTestUpdateCheck(params);
      initializing = replacement.initialize().catch((error: unknown) => error);
      const newRefresh = fixture.refreshGatewayUpdateStatus(() => params.cfg);
      expect(newRefresh).not.toBe(oldRefresh);
      expect(fixture.refreshGatewayUpdateStatus(() => params.cfg)).toBe(newRefresh);
      newRefreshing = newRefresh.catch((error: unknown) => error);
      let stopped = false;
      stopping = replacement.stop().then(() => {
        stopped = true;
      });
      expect(oldSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
      remote.resolve(status);
      await Promise.all([refreshing, initializing, newRefreshing, stopping]);
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(1);
    } finally {
      remote.resolve(status);
      await Promise.all([refreshing, initializing, newRefreshing, stopping]);
    }
  });

  it("cancels and joins a commit summary read before stopping discovery", async ({ signal }) => {
    mockDevGitStatus();
    process.env.NODE_ENV = "production";
    const logRead = createDeferred<Awaited<ReturnType<typeof fixture.runCommandWithTimeout>>>();
    const entered = createDeferred();
    vi.mocked(fixture.runCommandWithTimeout).mockImplementationOnce(() => {
      entered.resolve();
      return logRead.promise;
    });
    const onUpdateAvailableChange = vi.fn();
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "dev" } },
      onUpdateAvailableChange,
    });
    let stopped = false;
    const result = {
      stdout: "abc123\tsynthetic commit\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
    const checking = fixture.clock.advanceBy(0);
    try {
      await withinTest(entered.promise, signal);
      const [argv, options] = vi.mocked(fixture.runCommandWithTimeout).mock.calls[0] ?? [];
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
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
    });
    await fixture.clock.advanceBy(0);
    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);
    await fixture.clock.advanceBy(60 * 60 * 1000 - 1);
    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);
    await fixture.clock.advanceBy(1);
    expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(3);
    await stop();
  });

  it("uses current config for scheduled update and catalog checks", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.NODE_ENV = "production";
    let cfg: OpenClawConfig = { update: { channel: "beta" } };
    const params = {
      getConfig: () => cfg,
      applyRemoteCatalogUpdate: async () => "unchanged" as const,
      log: { info: vi.fn() },
      isNixMode: false,
      lifecycle: createGatewayUpdateLifecycle(fixture.scheduler),
    };
    const check = fixture.createGatewayUpdateCheck(params);
    fixture.updateChecks.add(check);
    check.start();
    await fixture.clock.advanceBy(0);
    expect(fixture.getUpdateSchedule()?.channel).toBe("beta");

    cfg = {
      update: { channel: "stable" },
      telemetry: { enabled: false },
      models: { catalogRefresh: { enabled: false } },
    };
    await fixture.clock.advanceBy(6 * 60 * 60_000);
    expect(refreshRemoteModelCatalogMock).toHaveBeenLastCalledWith({
      config: cfg,
      signal: expect.any(AbortSignal),
    });
    await fixture.clock.advanceBy(18 * 60 * 60_000);
    expect(fixture.getUpdateSchedule()?.channel).toBe("stable");
    expectLastTelemetryConfig(cfg);
  });

  it("reads telemetry consent after awaited install discovery", async ({ signal }) => {
    mockPackageInstallStatus();
    const discovery = createDeferred<UpdateCheckResult>();
    const entered = createDeferred();
    vi.mocked(fixture.checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const status: UpdateCheckResult = {
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    };
    let cfg: OpenClawConfig = { telemetry: { enabled: true } };
    const params = {
      getConfig: () => cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    };
    const checking = fixture.runGatewayUpdateCheckOwner(params);
    try {
      await withinTest(entered.promise, signal);
      cfg = { telemetry: { enabled: false } };
      discovery.resolve(status);
      await checking;

      expect(checkTelemetryUpdateMock).toHaveBeenCalledOnce();
      expectLastTelemetryConfig(cfg);
    } finally {
      discovery.resolve(status);
      await checking;
    }
  });

  it("drains stopped discovery before a replacement scheduler", async ({ signal }) => {
    const oldGitStatus = mockDevGitStatus({ upstreamSha: "old-upstream" });
    const entered = createDeferred();
    const oldFetch = createDeferred<UpdateCheckResult>();
    vi.mocked(fixture.checkUpdateStatus)
      .mockResolvedValueOnce(oldGitStatus)
      .mockImplementationOnce(() => {
        entered.resolve();
        return oldFetch.promise;
      });
    process.env.NODE_ENV = "production";
    const onOldSchedule = vi.fn();
    const onOldAvailable = vi.fn();
    const stopOld = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      activeWorkInspectors: idleActiveWorkInspectors(),
      onUpdateScheduleChange: onOldSchedule,
      onUpdateAvailableChange: onOldAvailable,
    });
    const checking = fixture.clock.advanceBy(0);
    let stopReplacement: (() => Promise<void>) | undefined;
    let replacementChecking: ReturnType<typeof fixture.clock.advanceBy> = undefined;
    try {
      await withinTest(entered.promise, signal);
      const stoppingOld = stopOld();
      mockDevGitStatus({ upstreamSha: "new-upstream", behind: 3 });
      stopReplacement = scheduleGatewayUpdateCheck({
        cfg: { update: { channel: "dev", auto: { enabled: true } } },
        activeWorkInspectors: idleActiveWorkInspectors(),
      });
      replacementChecking = fixture.clock.advanceBy(0);
      await Promise.resolve();
      expect(fixture.checkUpdateStatus).toHaveBeenCalledTimes(2);

      oldFetch.resolve(oldGitStatus);
      await Promise.all([checking, stoppingOld, replacementChecking]);

      expect(onOldSchedule).not.toHaveBeenCalled();
      expect(onOldAvailable).not.toHaveBeenCalled();
      expect(fixture.getUpdateSchedule()?.channel).toBe("dev");
      expect(fixture.getUpdateAvailable()?.upstreamSha).toBe("new-upstream");
    } finally {
      oldFetch.resolve(oldGitStatus);
      await Promise.all([checking, replacementChecking, stopOld(), stopReplacement?.()]);
    }
  });

  it("joins an aborted catalog refresh when it rejects", async ({ signal }) => {
    let capturedSignal: AbortSignal | undefined;
    const entered = createDeferred();
    const finished = createDeferred<Awaited<ReturnType<typeof refreshRemoteModelCatalogMock>>>();
    refreshRemoteModelCatalogMock.mockImplementationOnce(({ signal: catalogSignal }) => {
      capturedSignal = catalogSignal;
      entered.resolve();
      return finished.promise;
    });
    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "extended-stable", checkOnStart: false } },
    });

    let stopped = false;
    const checking = fixture.clock.advanceBy(0);
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
      refreshRemoteModelCatalogMock.mockResolvedValueOnce({
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

      await fixture.clock.advanceBy(0);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
      if (adoption === "failed") {
        // A failed adoption retries with the stored catalog, not after a full TTL.
        expect(info).toHaveBeenCalledWith("remote model catalog check failed", {
          error: expect.stringContaining("SyntaxError"),
        });
      }
      await fixture.clock.advanceBy(999);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
      await fixture.clock.advanceBy(1);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(2);
      await stop();
    },
  );
});
