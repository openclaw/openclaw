import { describe, expect, it, vi } from "vitest";
import { isReportableUpdateRun } from "../shared/update-outcome.js";
import { readRestartSentinel } from "./restart-sentinel.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { writeDevGitInstallReceipt } from "./update-startup-git.test-support.js";
import {
  setupUpdateStartupFixture,
  detectRespawnSupervisorMock,
  runUpdateFailureTriageMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  clock,
  handoffTransferStarted,
  checkUpdateStatus,
  resolveNpmChannelTag,
  runCommandWithTimeout,
  getUpdateAvailable,
  getUpdateSchedule,
  runGatewayUpdateCheck,
  writePersistedUpdateCheckState,
  mockPackageInstallStatus,
  mockNpmChannelTag,
  mockDevGitStatus,
  createAutoUpdateSuccessMock,
  idleActiveWorkInspectors,
  createBetaAutoUpdateConfig,
  runAutoUpdateCheckWithDefaults,
} from "./update-startup-suite.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./update-startup-suite.test-support.js"));

describe("update-startup", () => {
  setupUpdateStartupFixture();

  it("announces and applies a dev git campaign without consulting npm", async () => {
    mockDevGitStatus({
      branch: "HEAD",
      repositoryUrl: "https://github.com/example/openclaw",
    });
    const longSubject = "x".repeat(140);
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce({
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
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "dev",
      version: "99.0.0-dev.1",
    });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
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
    await clock.advanceBy(60_000);
    await handoffTransferStarted.promise;

    const [handoffParams] = startManagedServiceUpdateHandoffMock.mock.calls[0] ?? [];
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
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
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
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    await clock.advanceBy(60_000);
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

    expect(getUpdateSchedule()?.install?.git).toEqual({ currentSha: "current-sha", ...expected });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
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
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "waiting-for-idle" });
    busy = 0;
    await clock.advanceBy(5_000);
    expect(getUpdateSchedule()?.campaign).toMatchObject({ state: "countdown" });
    const applyAtMs = getUpdateSchedule()?.campaign?.applyAtMs;
    busy = 1;
    await clock.advanceBy(5_000);
    expect(getUpdateSchedule()?.campaign).toMatchObject({
      state: "countdown",
      applyAtMs,
    });

    await clock.advanceBy(55_000);
    expect(getUpdateSchedule()?.campaign?.state).toBe("applying");
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

    expect(getUpdateAvailable()).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    expect(runAutoUpdate).not.toHaveBeenCalled();

    clock.setTime(Date.now() + 60 * 60 * 1000 + 1);
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });

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

  it("supersedes and clears dev git campaigns from fresh git facts", async () => {
    mockDevGitStatus({ upstreamSha: "upstream-one" });
    const runAutoUpdate = createAutoUpdateSuccessMock();
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };

    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    const firstId = getUpdateSchedule()?.campaign?.id;
    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 3 });
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateSchedule()?.campaign?.id).not.toBe(firstId);
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "upstream-two" });

    mockDevGitStatus({ upstreamSha: "upstream-two", behind: 0 });
    await runGatewayUpdateCheck({
      cfg,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()?.target).toBeUndefined();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
  });

  it("keeps a foreground Gateway serving when automatic update has no restart owner", async () => {
    process.env.OPENCLAW_PROFILE = "work";
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    await runAutoUpdateCheckWithDefaults({ cfg: createBetaAutoUpdateConfig() });

    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(runUpdateFailureTriageMock).not.toHaveBeenCalled();
    const run = listUpdateRuns()[0]!;
    expect(run).toMatchObject({
      status: "skipped",
      reason: "managed-service-handoff-unavailable",
    });
    expect(isReportableUpdateRun(run)).toBe(false);
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
    await clock.advanceBy(60_000);

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
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
