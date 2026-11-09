import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isReportableUpdateRun } from "../shared/update-outcome.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import { UpdateCampaignController } from "./update-campaign.js";
import { currentUpdateCheckLifecycle } from "./update-check-lifecycle.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { useUpdateStartupTestFixture } from "./update-startup-fixture.test-support.js";
import { writeDevGitInstallReceipt } from "./update-startup-git.test-support.js";

const {
  cancelManagedServiceUpdateHandoffMock,
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  runUpdateFailureTriageMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} = await vi.hoisted(() => import("./update-startup.test-support.js"));

describe("update-startup automatic updates", () => {
  const fixture = useUpdateStartupTestFixture();
  const {
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
  } = fixture;

  it("announces and applies a dev git campaign without consulting npm", async () => {
    mockDevGitStatus({
      branch: "HEAD",
      repositoryUrl: "https://github.com/example/openclaw",
    });
    const longSubject = "x".repeat(140);
    vi.mocked(fixture.runCommandWithTimeout).mockResolvedValueOnce({
      stdout: [
        `aaaaaaa\t${longSubject}`,
        "bbbbbbb\tSecond commit",
        "ccccccc\tThird commit",
        "ddddddd\tFourth commit",
        "eeeeeee\tFifth commit",
        "fffffff\tUnexpected sixth commit",
      ].join("\n"),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    vi.mocked(fixture.resolveNpmChannelTag).mockResolvedValue({
      tag: "dev",
      version: "99.0.0-dev.1",
    });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(fixture.getUpdateAvailable()).toEqual({
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
    expect(fixture.getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runAutoUpdate).not.toHaveBeenCalled();

    await fixture.clock.advanceBy(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      runId: listUpdateRuns()[0]?.runId,
      signal: expect.any(AbortSignal),
      channel: "dev",
      mode: "git",
      timeoutMs: 45 * 60 * 1000,
      restartDrainTimeoutMs: 300_000,
      root: "/opt/openclaw",
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "upstream-sha",
      },
    });
  });

  it("pins managed dev campaign handoffs to the announced commit", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    const onUpdateRunCreated = vi.fn();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      activeWorkInspectors: idleActiveWorkInspectors(),
      onUpdateRunCreated,
    });
    await fixture.clock.advanceBy(60_000);
    await fixture.handoffTransferStarted.promise;

    const [handoffParams] = startManagedServiceUpdateHandoffMock.mock.calls[0] ?? [];
    const run = getUpdateRun(handoffParams!.meta!.runId!);
    expect(run).toMatchObject({
      trigger: "campaign",
      status: "running",
      origin: { campaignId: fixture.getUpdateSchedule()?.campaign?.id },
      target: { kind: "git", sha: "frozen-upstream-sha" },
    });
    expect(onUpdateRunCreated).toHaveBeenCalledOnce();
    expect(handoffParams?.devTarget).toEqual({
      mode: "tracked",
      upstreamRef: "origin/main",
      upstreamSha: "frozen-upstream-sha",
    });
    expect(handoffParams?.timeoutMs).toBeUndefined();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });

  it("records an already-current dev campaign without restarting or triage", async () => {
    mockDevGitStatus({ upstreamSha: "frozen-upstream-sha" });
    const reason = "already-current";
    const runAutoUpdate = vi.fn().mockResolvedValue({
      status: "skipped",
      result: { status: "skipped", mode: "git", reason, steps: [], durationMs: 1 },
      message: "The selected version is already current.",
    });
    const terminalSentinels: Array<ReturnType<typeof readRestartSentinel>> = [];
    await runAutoUpdateCheckWithDefaults({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      runAutoUpdate,
      onUpdateScheduleChange: (schedule) => {
        if (!schedule.campaign) {
          terminalSentinels.push(readRestartSentinel());
        }
      },
    });
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
    expect(listUpdateRuns()).toEqual([
      expect.objectContaining({
        trigger: "campaign",
        status: "skipped",
        reason,
        phase: "finished",
      }),
    ]);
    expect((await terminalSentinels.at(-1))?.payload).toMatchObject({
      kind: "update",
      status: "skipped",
      stats: { reason },
      message: expect.stringContaining("already current"),
    });
    expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
  });

  it("continues automatic dev campaigns despite a failed handoff receipt", async () => {
    writeDevGitInstallReceipt({
      status: "error",
      ts: Date.now() - 60_000,
      reason: "managed-service-handoff-failed",
    });
    mockDevGitStatus({ branch: "HEAD" });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(fixture.checkUpdateStatus).toHaveBeenCalledWith({
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
    expect(fixture.getUpdateSchedule()?.campaign?.state).toBe("countdown");
    await fixture.clock.advanceBy(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "upstream-sha",
        },
      }),
    );
  });

  it("keeps a dev campaign countdown stable when active work begins", async () => {
    mockDevGitStatus();
    let busy = 1;
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log,
      activeWorkInspectors: {
        ...idleActiveWorkInspectors(),
        getQueueSize: () => busy,
      },
      runAutoUpdate,
    });
    expect(fixture.getUpdateSchedule()?.campaign).toMatchObject({ state: "waiting-for-idle" });
    busy = 0;
    await fixture.clock.advanceBy(5_000);
    expect(fixture.getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
    const applyAtMs = fixture.getUpdateSchedule()?.campaign?.applyAtMs;
    busy = 1;
    await fixture.clock.advanceBy(5_000);
    expect(fixture.getUpdateSchedule()?.campaign).toMatchObject({
      state: "countdown",
      applyAtMs,
    });

    await fixture.clock.advanceBy(55_000);
    expect(fixture.getUpdateSchedule()?.campaign?.state).toBe("applying");
    expect(runAutoUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a new dev target visible during the automatic attempt cooldown", async () => {
    writePersistedUpdateCheckState({
      autoLastAttemptVersion: "upstream-one",
      autoLastAttemptAt: new Date(Date.now()).toISOString(),
    });
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };

    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(fixture.getUpdateAvailable()).toMatchObject({ upstreamSha: "upstream-two" });
    expect(fixture.getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
    expect(runAutoUpdate).not.toHaveBeenCalled();

    fixture.clock.setTime(Date.now() + 60 * 60 * 1000 + 1);
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

    expect(fixture.getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runAutoUpdate).not.toHaveBeenCalled();
    await fixture.clock.advanceBy(60_000);
    expect(runAutoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "dev",
        devTarget: expect.objectContaining({ upstreamSha: "upstream-two" }),
      }),
    );
  });

  it("supersedes and clears dev git campaigns from fresh git facts", async () => {
    mockDevGitStatus({ upstreamSha: "upstream-one" });
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };

    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    const firstId = fixture.getUpdateSchedule()?.campaign?.id;
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(fixture.getUpdateSchedule()?.campaign?.id).not.toBe(firstId);
    expect(fixture.getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });

    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 0 });
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(fixture.getUpdateAvailable()).toBeNull();
    expect(fixture.getUpdateSchedule()?.target).toBeUndefined();
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
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
      await fixture.runGatewayUpdateCheckOwner(params);
      expect(fixture.getUpdateSchedule()?.campaign?.state).toBe("countdown");
      cfg = {
        update: {
          channel: change === "channel-changed" ? "stable" : channel,
          checkOnStart: change !== "checks-disabled",
          auto: { enabled: change !== "auto-disabled" },
        },
      };
      await fixture.clock.advanceBy(60_000);

      expect(runAutoUpdate).not.toHaveBeenCalled();
      expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
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
    let applyingWake: ReturnType<typeof fixture.clock.advanceBy> = undefined;
    try {
      await fixture.runGatewayUpdateCheckOwner(params);
      applyingWake = fixture.clock.advanceBy(60_000);
      await withinTest(entered.promise, signal);
      const admitted = fixture.getUpdateSchedule()?.campaign;
      expect(admitted?.state).toBe("applying");
      cfg = { update: { checkOnStart: false } };
      await fixture.runGatewayUpdateCheckOwner(params);
      expect(fixture.getUpdateSchedule()?.campaign).toEqual(admitted);
    } finally {
      applying.resolve({ status: "handoff" });
      await applyingWake;
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
      let applyingWake: ReturnType<typeof fixture.clock.advanceBy> = undefined;
      try {
        await fixture.clock.advanceBy(0);
        applyingWake = fixture.clock.advanceBy(60_000);
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
    let releaseTriage!: (report: typeof fixture.triageResult) => void;
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
    let applyingWake: ReturnType<typeof fixture.clock.advanceBy> = undefined;
    try {
      await fixture.clock.advanceBy(0);
      applyingWake = fixture.clock.advanceBy(60_000);
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
      releaseTriage(fixture.triageResult);
      await stopping;

      expect(await readRestartSentinel()).toEqual(newer);
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(runUpdateFailureTriageMock).toHaveBeenCalledOnce();
    } finally {
      releaseTriage?.(fixture.triageResult);
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
      fixture.handoffTransferStarted.resolve();
      return transferred.promise;
    });
    process.env.NODE_ENV = "production";
    const stop = scheduleGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    let applyingWake: ReturnType<typeof fixture.clock.advanceBy> = undefined;
    try {
      await fixture.clock.advanceBy(0);
      applyingWake = fixture.clock.advanceBy(60_000);
      await withinTest(fixture.handoffTransferStarted.promise, signal);
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

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = vi.fn().mockResolvedValue({
      status: "handoff",
    });
    const stableAutoConfig = {
      update: {
        channel: "stable" as const,
        auto: {
          enabled: true,
        },
      },
    };

    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    fixture.clock.setTime(Date.parse("2026-01-18T07:00:00Z"));
    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    await fixture.clock.advanceBy(60_000);

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
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
    const campaign = new UpdateCampaignController(fixture.scheduler);
    currentUpdateCheckLifecycle().campaign = campaign;
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "stable" as const, auto: { enabled: true } } };
    mockPackageUpdateStatus("latest", "2.0.0");
    writePersistedUpdateCheckState({
      autoInstallId: "stable-held-install",
      autoFirstSeenVersion: "2.0.0",
      autoFirstSeenTag: "latest",
      autoFirstSeenAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    });
    const check = () =>
      runGatewayUpdateCheck({
        cfg,
        activeWorkInspectors: idleActiveWorkInspectors(),
        runAutoUpdate,
      });

    try {
      await check();
      expect(campaign.hold()).toBe(true);
      fixture.clock.setTime(Date.now() + 60 * 60_000);
      mockNpmChannelTag("latest", "3.0.0");

      await check();

      expect(fixture.getUpdateSchedule()?.target).toEqual({ kind: "package", version: "3.0.0" });
      expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
      await fixture.clock.advanceBy(65_000);
      expect(runAutoUpdate).not.toHaveBeenCalled();
    } finally {
      campaign.clear();
    }
  });

  it("disables all automatic update traffic when checkOnStart is false", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { ...createBetaAutoUpdateConfig().update, checkOnStart: false } },
      runAutoUpdate,
      log,
    });

    await fixture.clock.advanceBy(60_000);

    expect(log.info).not.toHaveBeenCalled();
    expect(readPersistedUpdateCheckState()).toBeNull();
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(fixture.checkUpdateStatus).not.toHaveBeenCalled();
    expect(fixture.getUpdateAvailable()).toBeNull();
    expect(fixture.getUpdateSchedule()).toMatchObject({ channel: "beta", autoEnabled: false });
  });

  it("disables update notices, telemetry, and auto-update with OPENCLAW_NO_AUTO_UPDATE", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_NO_AUTO_UPDATE = "1";
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(fixture.resolveNpmChannelTag).not.toHaveBeenCalled();
    expect(fixture.checkUpdateStatus).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("keeps external auto-update supervision authoritative over native systemd markers", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    detectRespawnSupervisorMock.mockReturnValue("systemd");
    const log = { info: vi.fn() };
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      runAutoUpdate,
    });

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
    const log = { info: vi.fn() };
    await runAutoUpdateCheckWithDefaults({ cfg: createBetaAutoUpdateConfig(), log });

    expect(fixture.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
    const run = listUpdateRuns()[0]!;
    expect(run).toMatchObject({
      status: "skipped",
      phase: "finished",
      reason: "managed-service-handoff-unavailable",
      before: { version: "1.0.0" },
    });
    expect(run.after).toEqual({});
    expect(isReportableUpdateRun(run)).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      "auto-update attempt skipped",
      expect.objectContaining({ reason: "managed-service-handoff-unavailable" }),
    );
    expect(log.info).not.toHaveBeenCalledWith("auto-update attempt failed", expect.anything());
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
    expect(fixture.getUpdateAvailable()).toMatchObject({ latestVersion: "2.0.0-beta.1" });
    expect((await readRestartSentinel())?.payload).toMatchObject({
      kind: "update",
      status: "skipped",
      message: expect.stringMatching(
        /Stop the foreground Gateway.*`openclaw --profile work update --yes --channel beta --tag 2\.0\.0-beta\.1`.*then launch the Gateway again/s,
      ),
      stats: {
        reason: "managed-service-handoff-unavailable",
        before: { version: "1.0.0" },
        after: null,
        steps: [],
      },
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
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(startupError);
    runUpdateFailureTriageMock.mockResolvedValueOnce({
      status: "failed",
      hint: "Triage could not complete: collector failed. Run openclaw triage.",
    });
    const log = { info: vi.fn() };
    const terminalSentinels: Array<ReturnType<typeof readRestartSentinel>> = [];

    await runGatewayUpdateCheck({
      cfg: createBetaAutoUpdateConfig(),
      log,
      activeWorkInspectors: idleActiveWorkInspectors(),
      onUpdateScheduleChange: (schedule) => {
        if (!schedule.campaign) {
          terminalSentinels.push(readRestartSentinel());
        }
      },
    });
    await fixture.clock.advanceBy(60_000);

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(fixture.getUpdateSchedule()?.campaign).toBeUndefined();
    expect((await terminalSentinels.at(-1))?.payload).toMatchObject({
      kind: "update",
      status: "error",
      doctorHint: expect.stringContaining("openclaw triage"),
      stats: { reason: "managed-service-handoff-failed" },
    });
    expect(runUpdateFailureTriageMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(runUpdateFailureTriageMock.mock.calls[0]?.[0].failure)).not.toContain(
      helperPath,
    );
    expect(JSON.stringify((await terminalSentinels.at(-1))?.payload)).not.toContain(helperPath);
    expect(listUpdateRuns()[0]).toMatchObject({
      target: { installationMethod: "managed-service" },
      verification: { rollbackOutcome: { status: "not-attempted" } },
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "managed-service",
          status: "failed",
          failureFacts: [expect.objectContaining({ check: "managed-service", code: "ENOENT" })],
        }),
      ]),
    });
  });

  it("does not schedule another restart when auto-update joins an active handoff", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "joined",
      message: "Update blocked by another update lease.",
      pid: 12345,
      command: "openclaw update --yes --channel beta",
      logPath: "/tmp/openclaw-handoff.log",
      handoffId: "handoff-existing",
    });

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
    });

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
    expect(listUpdateRuns()).toEqual([
      expect.objectContaining({
        trigger: "campaign",
        status: "skipped",
        reason: "managed-service-handoff-already-running",
        origin: expect.objectContaining({ nextAction: "Update blocked by another update lease." }),
        finishedAtMs: expect.any(Number),
      }),
    ]);
  });
});
