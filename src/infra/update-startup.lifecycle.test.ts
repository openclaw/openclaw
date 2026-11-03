import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import {
  setupUpdateStartupFixture,
  cancelManagedServiceUpdateHandoffMock,
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  runUpdateFailureTriageMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  scheduler,
  clock,
  handoffTransferStarted,
  triageResult,
  checkUpdateStatus,
  runCommandWithTimeout,
  runGatewayUpdateCheckOwner,
  createGatewayUpdateCheck,
  getUpdateAvailable,
  getUpdateEffectiveChannel,
  getUpdateSchedule,
  refreshGatewayUpdateStatus,
  updateChecks,
  createTestUpdateCheck,
  scheduleGatewayUpdateCheck,
  readPersistedUpdateCheckState,
  expectLastTelemetryConfig,
  mockPackageUpdateStatus,
  mockPackageInstallStatus,
  mockDevGitStatus,
  createAutoUpdateSuccessMock,
  idleActiveWorkInspectors,
  createBetaAutoUpdateConfig,
} from "./update-startup-suite.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./update-startup-suite.test-support.js"));

describe("update-startup", () => {
  setupUpdateStartupFixture();

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
    const check = createTestUpdateCheck({
      cfg: { update: { channel: "dev" } },
    });
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
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return remote.promise;
    });
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
    vi.mocked(runCommandWithTimeout).mockImplementationOnce(() => {
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
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
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
    const params = {
      getConfig: () => cfg,
      applyRemoteCatalogUpdate: async () => "unchanged" as const,
      log: { info: vi.fn() },
      isNixMode: false,
      lifecycle: createGatewayUpdateLifecycle(scheduler),
    };
    const check = createGatewayUpdateCheck(params);
    updateChecks.add(check);
    check.start();
    await clock.advanceBy(0);
    expect(getUpdateSchedule()?.channel).toBe("beta");

    cfg = {
      update: { channel: "stable" },
      telemetry: { enabled: false },
      models: { catalogRefresh: { enabled: false } },
    };
    await clock.advanceBy(6 * 60 * 60_000);
    expect(refreshRemoteModelCatalogMock).toHaveBeenLastCalledWith({
      config: cfg,
      signal: expect.any(AbortSignal),
    });
    await clock.advanceBy(18 * 60 * 60_000);
    expect(getUpdateSchedule()?.channel).toBe("stable");
    expectLastTelemetryConfig(cfg);
  });

  it("reads telemetry consent after awaited install discovery", async ({ signal }) => {
    mockPackageInstallStatus();
    const discovery = createDeferred<UpdateCheckResult>();
    const entered = createDeferred();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
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
    const checking = runGatewayUpdateCheckOwner(params);
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

  it.each([
    { channel: "beta", change: "auto-disabled" },
    { channel: "beta", change: "checks-disabled" },
    { channel: "beta", change: "channel-changed" },
  ] as const)(
    "rechecks $channel countdown admission after $change",
    async ({ channel, change }) => {
      mockPackageUpdateStatus("beta", "2.0.0-beta.1");
      let cfg: OpenClawConfig = { update: { channel, auto: { enabled: true } } };
      const runAutoUpdate = createAutoUpdateSuccessMock();
      const params = {
        getConfig: () => cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
        activeWorkInspectors: idleActiveWorkInspectors(),
        runAutoUpdate,
      };
      await runGatewayUpdateCheckOwner(params);
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
    const runAutoUpdate = vi.fn(() => {
      entered.resolve();
      return applying.promise;
    });
    let cfg: OpenClawConfig = createBetaAutoUpdateConfig();
    const params = {
      getConfig: () => cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    };
    let applyingWake: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await runGatewayUpdateCheckOwner(params);
      applyingWake = clock.advanceBy(60_000);
      await withinTest(entered.promise, signal);
      const admitted = getUpdateSchedule()?.campaign;
      expect(admitted?.state).toBe("applying");
      cfg = { update: { checkOnStart: false } };
      await runGatewayUpdateCheckOwner(params);
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
    const checking = clock.advanceBy(0);
    let stopReplacement: (() => Promise<void>) | undefined;
    let replacementChecking: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await withinTest(entered.promise, signal);
      const stoppingOld = stopOld();
      mockDevGitStatus({ upstreamSha: "new-upstream", behind: 3 });
      stopReplacement = scheduleGatewayUpdateCheck({
        cfg: { update: { channel: "dev", auto: { enabled: true } } },
        activeWorkInspectors: idleActiveWorkInspectors(),
      });
      replacementChecking = clock.advanceBy(0);
      await Promise.resolve();
      expect(checkUpdateStatus).toHaveBeenCalledTimes(2);

      oldFetch.resolve(oldGitStatus);
      await Promise.all([checking, stoppingOld, replacementChecking]);

      expect(onOldSchedule).not.toHaveBeenCalled();
      expect(onOldAvailable).not.toHaveBeenCalled();
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
      mockPackageUpdateStatus("beta", "2.0.0-beta.1");
      detectRespawnSupervisorMock.mockReturnValue("systemd");
      cancelManagedServiceUpdateHandoffMock.mockResolvedValueOnce(cancelled);
      const entered = createDeferred();
      let releaseHandoff!: () => void;
      startManagedServiceUpdateHandoffMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            entered.resolve();
            releaseHandoff = () => {
              const handoff = {
                pid: 12345,
                command: "openclaw update --yes --channel beta",
                logPath: "/tmp/late-handoff.log",
                handoffId: "late-handoff",
                installRoot: "/opt/openclaw",
              };
              resolve(
                joined
                  ? {
                      ...handoff,
                      status: "joined",
                      message: "Another managed update is already running.",
                    }
                  : { ...handoff, status: "started" },
              );
            };
          }),
      );
      process.env.NODE_ENV = "production";
      const log = { info: vi.fn() };
      const stop = scheduleGatewayUpdateCheck({
        cfg: createBetaAutoUpdateConfig(),
        log,
        activeWorkInspectors: idleActiveWorkInspectors(),
      });
      let applyingWake: ReturnType<typeof clock.advanceBy> = undefined;
      try {
        await clock.advanceBy(0);
        applyingWake = clock.advanceBy(60_000);
        await withinTest(entered.promise, signal);
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
          expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        } else {
          expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledWith({
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
        expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
        expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(await readRestartSentinel()).toBeNull();
        expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
      } finally {
        releaseHandoff?.();
        await Promise.all([applyingWake, stop()]);
      }
    },
  );

  it("does not publish triage from a stopped scheduler over a newer restart", async ({
    signal,
  }) => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("systemd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const entered = createDeferred();
    let releaseTriage!: (report: typeof triageResult) => void;
    runUpdateFailureTriageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          entered.resolve();
          releaseTriage = resolve;
        }),
    );
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    let applyingWake: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await clock.advanceBy(0);
      applyingWake = clock.advanceBy(60_000);
      await withinTest(entered.promise, signal);
      expect(runUpdateFailureTriageMock).toHaveBeenCalledOnce();
      const stopping = stop();
      await writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "newer restart",
      });
      const newer = await readRestartSentinel();
      releaseTriage(triageResult);
      await stopping;

      expect(await readRestartSentinel()).toEqual(newer);
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(runUpdateFailureTriageMock).toHaveBeenCalledOnce();
    } finally {
      releaseTriage?.(triageResult);
      await Promise.all([applyingWake, stop()]);
    }
  });

  it("joins and cancels an ownership transfer that completes after scheduler stop", async ({
    signal,
  }) => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("systemd");
    const transferred = createDeferred<boolean>();
    transferManagedServiceUpdateHandoffMock.mockImplementationOnce(() => {
      handoffTransferStarted.resolve();
      return transferred.promise;
    });
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    let applyingWake: ReturnType<typeof clock.advanceBy> = undefined;
    try {
      await clock.advanceBy(0);
      applyingWake = clock.advanceBy(60_000);
      await withinTest(handoffTransferStarted.promise, signal);
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();

      transferred.resolve(true);
      await stopping;

      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: "auto-handoff-id",
        installRoot: "/opt/openclaw",
      });
      expect(await readRestartSentinel()).toBeNull();
      expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
    } finally {
      transferred.resolve(true);
      await Promise.all([applyingWake, stop()]);
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

      await clock.advanceBy(0);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
      if (adoption === "failed") {
        // A failed adoption retries with the stored catalog, not after a full TTL.
        expect(info).toHaveBeenCalledWith("remote model catalog check failed", {
          error: expect.stringContaining("SyntaxError"),
        });
      }
      await clock.advanceBy(999);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(1);
      await clock.advanceBy(1);
      expect(refreshRemoteModelCatalogMock).toHaveBeenCalledTimes(2);
      await stop();
    },
  );
});
