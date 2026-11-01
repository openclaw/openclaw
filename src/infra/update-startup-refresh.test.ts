import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { UpdateCampaignController } from "./update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveNpmChannelTag,
  type UpdateCheckResult,
} from "./update-check.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";
import { runCampaignUpdate } from "./update-startup-auto-run.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import { pauseAt, expectNoCalls } from "./update-startup-suite.test-support.js";
import { runGatewayUpdateCheck as runGatewayUpdateCheckOwner } from "./update-startup.js";
import { getGatewayUpdateSchedule, refreshGatewayUpdateStatus } from "./update-status-schedule.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateStatusState,
} from "./update-status-state.js";

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "1.0.0",
}));
// mock-isolation: Synthetic update checks keep reads and writes independent of shared SQLite state.
vi.mock("../state/config-machine-state-async.js", () => ({
  readConfigMachineStateAsync: vi.fn(async () => null),
  writeConfigMachineStateAsync: vi.fn(async () => {}),
}));
vi.mock("./openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));
vi.mock("./restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-sentinel.js")>()),
  readVerifiedGitUpdateReceipt: vi.fn(async () => null),
}));
vi.mock("./telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telemetry.js")>()),
  checkTelemetryUpdate: vi.fn(),
}));
vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus: vi.fn(),
  compareSemverStrings: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));
vi.mock("./update-git-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-git-metadata.js")>()),
  resolveDevGitCommits: vi.fn(),
}));
vi.mock("./update-startup-auto-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-startup-auto-run.js")>()),
  runCampaignUpdate: vi.fn(async () => "handoff"),
}));
vi.mock("./gateway-active-work.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-active-work.js")>()),
  createGatewayActiveWorkSnapshot: vi.fn(() => ({ idle: true })),
}));
vi.mock("./gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-supervision.js")>()),
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON: "external-supervisor-update-required",
  isGatewayExternallySupervised: vi.fn(() => false),
}));

function mockDevGitStatus(params?: Parameters<typeof createDevGitStatus>[0]) {
  const status = createDevGitStatus(params);
  vi.mocked(checkUpdateStatus).mockResolvedValue(status);
  return status;
}

const devConfig: OpenClawConfig = { update: { channel: "dev" } };
const autoConfig: OpenClawConfig = { update: { channel: "dev", auto: { enabled: true } } };
const packageStatus: UpdateCheckResult = {
  root: "/opt/openclaw",
  installKind: "package",
  packageManager: "npm",
};

function expectGitTarget(upstreamSha: string, commitsBehind?: number, repositoryUrl?: string) {
  const target = { upstreamSha, ...(commitsBehind === undefined ? {} : { commitsBehind }) };
  expect(getUpdateAvailable()).toMatchObject({
    ...target,
    ...(repositoryUrl ? { currentSha: "current-sha", repositoryUrl } : {}),
  });
  expect(getUpdateSchedule()?.target).toMatchObject({
    kind: "git",
    upstreamRef: "origin/main",
    ...target,
  });
}

async function expectCampaignApplies(upstreamSha: string) {
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runCampaignUpdate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      version: upstreamSha,
      devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha },
    }),
  );
}

function runGatewayUpdateCheck({
  cfg,
  ...params
}: {
  cfg: OpenClawConfig | (() => OpenClawConfig);
} & Partial<Omit<Parameters<typeof runGatewayUpdateCheckOwner>[0], "getConfig">>) {
  return runGatewayUpdateCheckOwner({
    log: { info: vi.fn() },
    isNixMode: false,
    allowInTests: true,
    ...params,
    getConfig: typeof cfg === "function" ? cfg : () => cfg,
  });
}

function paused<T>(fallback: T) {
  const entered = createDeferred();
  const result = createDeferred<T>();
  return {
    call: pauseAt(entered, result),
    resolve: result.resolve,
    async during(pending: Promise<unknown>, check: (resume: (value: T) => void) => Promise<void>) {
      try {
        await entered.promise;
        await check(result.resolve);
      } finally {
        result.resolve(fallback);
        await pending;
      }
    },
  };
}

describe("interactive Dev update discovery", () => {
  let lifecycle: UpdateCheckLifecycle;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let campaign: UpdateCampaignController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
    vi.mocked(checkUpdateStatus).mockReset().mockResolvedValue(createDevGitStatus());
    vi.mocked(checkTelemetryUpdate).mockReset().mockResolvedValue(null);
    vi.mocked(resolveNpmChannelTag).mockReset();
    vi.mocked(compareSemverStrings).mockReset();
    vi.mocked(resolveDevGitCommits).mockReset().mockResolvedValue([]);
    vi.mocked(runCampaignUpdate).mockClear();
    resetUpdateStatusState();
    scheduler = createTestGatewayScheduler("fake-timers");
    lifecycle = createGatewayUpdateLifecycle(scheduler);
    campaign = new UpdateCampaignController(scheduler);
    lifecycle.campaign = campaign;
  });

  afterEach(async () => {
    await lifecycle.stop();
    await scheduler.stop();
    resetUpdateStatusState();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("publishes a configless Git refresh and projects the current automatic-update policy", async () => {
    mockDevGitStatus({ behind: 2 });
    await runGatewayUpdateCheck({ cfg: { update: { channel: "dev", auto: { enabled: true } } } });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    mockDevGitStatus({
      behind: 3,
      upstreamSha: "new-upstream-sha",
      repositoryUrl: "https://github.com/example/openclaw",
    });

    await refreshGatewayUpdateStatus(() => ({}));

    const projected = getGatewayUpdateSchedule({}, "dev");
    expect(projected).toMatchObject({
      autoEnabled: false,
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "new-upstream-sha",
        commitsBehind: 3,
      },
      install: {
        kind: "git",
        git: {
          status: "behind",
          currentSha: "current-sha",
          upstreamSha: "new-upstream-sha",
          repositoryUrl: "https://github.com/example/openclaw",
          commitsBehind: 3,
        },
      },
    });
    expect(projected.campaign).toBeUndefined();
    expectGitTarget("new-upstream-sha", 3, "https://github.com/example/openclaw");
  });

  it("preserves an announced campaign when installation identity cannot establish a target", async () => {
    const cfg = autoConfig;
    mockDevGitStatus({ upstreamSha: "announced-upstream" });
    await runGatewayUpdateCheck({ cfg });
    const announced = campaign.getState();
    const available = getUpdateAvailable();
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      error: { status: "failed", message: "Installation probe failed" },
    });
    await expect(refreshGatewayUpdateStatus(() => cfg)).rejects.toThrow("could not be checked");
    expect(campaign.getState()).toBe(announced);
    expect(getUpdateAvailable()).toBe(available);
    expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "announced-upstream" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: "announced-upstream" }),
    );
  });

  it.each(["package", "host", "immutable"] as const)(
    "retires an announced Git campaign for a %s install",
    async (installKind) => {
      const cfg: OpenClawConfig = { update: { auto: { enabled: true } } };
      mockDevGitStatus({ upstreamSha: "obsolete-git-target" });
      await runGatewayUpdateCheck({ cfg });
      expect(campaign.getState()?.state).toBe("countdown");
      vi.mocked(checkUpdateStatus).mockResolvedValue({ ...packageStatus, installKind });

      await refreshGatewayUpdateStatus(() => cfg);

      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(campaign.getState()).toBeUndefined();
      expect(lifecycle.installStatus?.status.installKind).toBe(installKind);
      expect(getUpdateSchedule()?.channel).toBe(installKind === "immutable" ? "dev" : "stable");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runCampaignUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tag: "v2026.10.0-beta.1", channel: "beta", fetchOk: true },
    { tag: "v2026.9.30", channel: "stable", fetchOk: false },
  ])(
    "retires an announced Dev campaign after discovering $channel Git identity (fetchOk=$fetchOk)",
    async ({ tag, channel, fetchOk }) => {
      const cfg: OpenClawConfig = { update: { auto: { enabled: true } } };
      const published = vi.fn();
      mockDevGitStatus({ upstreamSha: "obsolete-dev-target" });
      await runGatewayUpdateCheck({ cfg, onUpdateScheduleChange: published });
      expect(campaign.getState()?.state).toBe("countdown");
      published.mockClear();
      lifecycle.onUpdateScheduleChange = published;
      const fresh = createDevGitStatus({
        branch: "HEAD",
        fetchOk,
        ...(fetchOk ? {} : { upstreamSha: null, ahead: null, behind: null }),
      });
      vi.mocked(checkUpdateStatus).mockResolvedValue({ ...fresh, git: { ...fresh.git, tag } });

      const refresh = refreshGatewayUpdateStatus(() => cfg);
      if (fetchOk) {
        await refresh;
      } else {
        await expect(refresh).rejects.toThrow("could not be checked");
      }

      expect(getUpdateSchedule()?.channel).toBe(channel);
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(getUpdateAvailable()).toBeNull();
      expect(campaign.getState()).toBeUndefined();
      expect(lifecycle.installStatus?.status.git?.tag).toBe(tag);
      expect(published).toHaveBeenCalledExactlyOnceWith(getUpdateSchedule());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runCampaignUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(["channel replacement", "applying campaign"] as const)(
    "rejects a manual observation superseded by %s",
    async (replacement) => {
      const applying = replacement === "applying campaign";
      const cfg: OpenClawConfig = {
        update: { channel: "dev", ...(applying ? { auto: { enabled: true } } : {}) },
      };
      const oldStatus = mockDevGitStatus(
        applying ? { upstreamSha: "admitted-upstream" } : undefined,
      );
      if (applying) {
        await runGatewayUpdateCheck({ cfg });
      }
      const remote = paused<UpdateCheckResult>(createDevGitStatus());
      vi.mocked(checkUpdateStatus).mockImplementationOnce(remote.call);
      const refresh = refreshGatewayUpdateStatus(() => cfg).catch((error: unknown) => error);
      await remote.during(refresh, async (resume) => {
        if (applying) {
          expect(campaign.adopt().status).toBe("adopted");
        } else if (replacement === "channel replacement") {
          await runGatewayUpdateCheck({
            cfg: { update: { channel: "beta", checkOnStart: false } },
          });
        }
        const schedule = getUpdateSchedule();
        const available = getUpdateAvailable();
        resume(
          applying ? createDevGitStatus({ upstreamSha: "new-upstream", behind: 4 }) : oldStatus,
        );
        expect(await refresh).toEqual(
          expect.objectContaining({ message: expect.stringContaining("superseded") }),
        );
        expect(getUpdateSchedule()).toEqual(schedule);
        if (applying) {
          expect(getUpdateAvailable()).toEqual(available);
        }
      });
    },
  );

  it("does not supersede an active stable package check with an availability-preserving manual refresh", async () => {
    const cfg: OpenClawConfig = { update: { channel: "stable" } };
    vi.mocked(checkUpdateStatus).mockResolvedValue(packageStatus);
    vi.mocked(compareSemverStrings).mockReturnValue(-1);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "stable", version: "9.0.0" });
    const telemetry = paused<Awaited<ReturnType<typeof checkTelemetryUpdate>>>({
      version: "9.0.0",
    });
    vi.mocked(checkTelemetryUpdate).mockImplementationOnce(telemetry.call);
    const background = runGatewayUpdateCheck({ cfg });
    await telemetry.during(background, async (resume) => {
      await refreshGatewayUpdateStatus(() => cfg);
      resume({ version: "9.0.0" });
      await background;
      expect(getUpdateAvailable()?.latestVersion).toBe("9.0.0");
      expect(getUpdateSchedule()?.target).toEqual({ kind: "package", version: "9.0.0" });
    });
  });

  it.each([
    { channel: "stable", stage: "initialization" },
    { channel: "beta", stage: "telemetry" },
  ] as const)(
    "keeps manual Dev state after an old $channel Git check finishes $stage",
    async ({ channel, stage }) => {
      let cfg: OpenClawConfig = { update: { channel } };
      const installed = mockDevGitStatus({ upstreamSha: "old-upstream" });
      const identity = paused(installed);
      const telemetry = paused(null);
      if (stage === "initialization") {
        vi.mocked(checkUpdateStatus).mockImplementationOnce(identity.call);
      } else {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(telemetry.call);
      }
      const background = runGatewayUpdateCheck({ cfg: () => cfg });
      await (stage === "initialization" ? identity : telemetry).during(background, async () => {
        cfg = { update: { channel: "dev" } };
        mockDevGitStatus({ upstreamSha: "fresh-dev-target", behind: 4 });
        await refreshGatewayUpdateStatus(() => cfg);
        const schedule = getUpdateSchedule();
        const available = getUpdateAvailable();
        expect(schedule?.channel).toBe("dev");
        expect(schedule?.target).toMatchObject({ upstreamSha: "fresh-dev-target" });
        identity.resolve(installed);
        telemetry.resolve(null);
        await background;
        expect(getUpdateSchedule()).toEqual(schedule);
        expect(getUpdateAvailable()).toEqual(available);
        if (stage === "initialization") {
          expect(lifecycle.installStatus?.status.git?.upstreamSha).toBe("fresh-dev-target");
        }
        expect(runCampaignUpdate).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["telemetry", "registry"] as const)(
    "does not publish old package %s after manual discovery adopts a Git checkout",
    async (stage) => {
      const cfg = devConfig;
      const telemetry = paused(null);
      const registry = paused<Awaited<ReturnType<typeof resolveNpmChannelTag>>>({
        tag: "dev",
        version: "9.0.0",
      });
      vi.mocked(checkUpdateStatus).mockResolvedValue(packageStatus);
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "dev", version: "9.0.0" });
      if (stage === "telemetry") {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(telemetry.call);
      } else {
        vi.mocked(resolveNpmChannelTag).mockImplementationOnce(registry.call);
      }
      const background = runGatewayUpdateCheck({ cfg });
      await (stage === "telemetry" ? telemetry : registry).during(background, async () => {
        mockDevGitStatus({ upstreamSha: "fresh-git-target" });
        await refreshGatewayUpdateStatus(() => cfg);
        telemetry.resolve(null);
        registry.resolve({ tag: "dev", version: "9.0.0" });
        await background;
        expectGitTarget("fresh-git-target");
        expect(await lifecycle.initialize()).toBe(lifecycle.installStatus);
        expect(lifecycle.installStatus?.status.installKind).toBe("git");
        expect(resolveNpmChannelTag).toHaveBeenCalledTimes(stage === "registry" ? 1 : 0);
      });
    },
  );

  it("publishes manual target changes through the lifecycle callbacks", async () => {
    const onUpdateAvailableChange = vi.fn();
    const onUpdateScheduleChange = vi.fn();
    lifecycle = createGatewayUpdateLifecycle(scheduler, {
      onUpdateAvailableChange,
      onUpdateScheduleChange,
    });
    await refreshGatewayUpdateStatus(() => devConfig);
    expect(onUpdateAvailableChange).toHaveBeenLastCalledWith(getUpdateAvailable());
    expect(onUpdateScheduleChange).toHaveBeenLastCalledWith(getUpdateSchedule());

    mockDevGitStatus({ behind: 0 });
    await refreshGatewayUpdateStatus(() => devConfig);
    expect(onUpdateAvailableChange).toHaveBeenLastCalledWith(null);
    expect(onUpdateScheduleChange).toHaveBeenLastCalledWith(getUpdateSchedule());
  });

  it.each([
    { name: "ahead", git: { ahead: 2, behind: 0 }, status: "ahead" },
    { name: "Git probe error", git: { error: "git unavailable" }, status: "unavailable" },
    { name: "missing upstream", git: { upstream: null }, status: "unavailable" },
    { name: "missing upstream SHA", git: { upstreamSha: null }, status: "unavailable" },
    { name: "missing comparison", git: { ahead: null, behind: null }, status: "unavailable" },
  ])(
    "reconciles a $name manual Dev refresh without treating failure as absence",
    async ({ git, status }) => {
      const cfg = devConfig;
      mockDevGitStatus({ upstreamSha: "old-upstream" });
      await runGatewayUpdateCheck({ cfg });
      expect(getUpdateAvailable()?.upstreamSha).toBe("old-upstream");

      const checked = createDevGitStatus();
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        ...checked,
        git: { ...checked.git, ...git },
      });
      const refresh = refreshGatewayUpdateStatus(() => cfg);
      if (status === "unavailable") {
        await expect(refresh).rejects.toThrow("The latest Dev update could not be checked");
      } else {
        await refresh;
      }

      if (status === "unavailable") {
        expect(getUpdateAvailable()?.upstreamSha).toBe("old-upstream");
        expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "old-upstream" });
      } else {
        expect(getUpdateAvailable()).toBeNull();
        expect(getUpdateSchedule()?.target).toBeUndefined();
      }
      expect(getUpdateSchedule()?.install?.git?.status).toBe(status);
    },
  );

  it("publishes the last completed observation and reconciles its campaign", async () => {
    const cfg = autoConfig;
    const fetching = createDeferred();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit }) => {
      if (fetchGit) {
        fetching.resolve();
        return remote.promise;
      }
      return Promise.resolve(createDevGitStatus());
    });
    const background = runGatewayUpdateCheck({ cfg });
    const metadataStarted = createDeferred();
    const metadata = createDeferred<Awaited<ReturnType<typeof resolveDevGitCommits>>>();
    try {
      await fetching.promise;
      mockDevGitStatus({
        upstreamSha: "older-manual",
        behind: 2,
        repositoryUrl: "https://github.com/example/openclaw",
      });
      vi.mocked(resolveDevGitCommits).mockImplementationOnce(pauseAt(metadataStarted, metadata));
      const manual = refreshGatewayUpdateStatus(() => cfg).then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      await metadataStarted.promise;
      remote.resolve(createDevGitStatus({ upstreamSha: "newer-background", behind: 4 }));
      await background;
      const latest = getUpdateSchedule();
      expect(latest?.target).toMatchObject({ upstreamSha: "newer-background" });
      expect(campaign.getState()?.state).toBe("countdown");
      metadata.resolve([]);
      expect(await manual).toEqual({ status: "fulfilled" });
      expectGitTarget("older-manual", 2, "https://github.com/example/openclaw");
      expect(campaign.getState()?.state).toBe("countdown");
      expect(runCampaignUpdate).not.toHaveBeenCalled();
      await expectCampaignApplies("older-manual");
    } finally {
      remote.resolve(createDevGitStatus());
      metadata.resolve([]);
      await background;
    }
  });

  it.each([
    { disabledBy: "environment", discovery: "manual" },
    { disabledBy: "config", discovery: "background-reenabled" },
  ] as const)(
    "disabled background checks preserve $discovery discovery policy ($disabledBy)",
    async ({ disabledBy, discovery }) => {
      const cfg = {
        update: { channel: "dev" as const, auto: { enabled: true }, checkOnStart: true },
      };
      const disable = () => {
        if (disabledBy === "config") {
          cfg.update.checkOnStart = false;
        } else {
          vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "1");
        }
      };
      if (discovery === "manual") {
        disable();
      }
      const remote = paused<UpdateCheckResult>(createDevGitStatus());
      vi.mocked(checkUpdateStatus).mockImplementationOnce(remote.call);
      const params = { cfg, log: { info: vi.fn() }, isNixMode: false, allowInTests: true };
      const pending = (
        discovery === "manual"
          ? refreshGatewayUpdateStatus(() => cfg)
          : runGatewayUpdateCheck(params)
      ).catch((error: unknown) => error);
      await remote.during(pending, async (resume) => {
        disable();
        await runGatewayUpdateCheck(params);
        expect(checkUpdateStatus).toHaveBeenCalledTimes(1);
        if (discovery === "background-reenabled") {
          cfg.update.checkOnStart = true;
          vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
        }
        resume(createDevGitStatus({ upstreamSha: "fresh-upstream", behind: 4 }));
        expect(await pending).toBeUndefined();
        if (discovery === "manual") {
          expectGitTarget("fresh-upstream");
        } else {
          expect(getUpdateSchedule()?.target).toBeUndefined();
          expect(getUpdateAvailable()).toBeNull();
        }
        expect(campaign.getState()?.state).toBeUndefined();
        expectNoCalls(checkTelemetryUpdate, runCampaignUpdate);
      });
    },
  );

  it("lets progressing discovery outlive the former quick-check budget", async () => {
    mockDevGitStatus();
    const started = createDeferred<AbortSignal | undefined>();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(({ signal }) => {
      started.resolve(signal);
      return remote.promise;
    });
    let settled = false;
    const refresh = refreshGatewayUpdateStatus(() => devConfig).catch((error: unknown) => error);
    void refresh.then(() => {
      settled = true;
    });
    try {
      const signal = await started.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      remote.resolve(createDevGitStatus());
      expect(await refresh).toBeUndefined();
      expect(getUpdateAvailable()?.upstreamSha).toBe("upstream-sha");
    } finally {
      remote.resolve(createDevGitStatus());
      await refresh;
    }
  });
});
