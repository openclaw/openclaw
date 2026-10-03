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
import { runGatewayUpdateCheck as runGatewayUpdateCheckOwner } from "./update-startup.js";
import { getGatewayUpdateSchedule, refreshGatewayUpdateStatus } from "./update-status-schedule.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateAvailableCache,
  setUpdateScheduleCache,
} from "./update-status-state.js";

vi.mock("../version.js", () => ({ VERSION: "1.0.0" }));
vi.mock("../state/config-machine-state.js", () => ({ readConfigMachineState: vi.fn(() => null) }));
vi.mock("../state/config-machine-state-write.js", () => ({ writeConfigMachineState: vi.fn() }));
vi.mock("../model-catalog/remote-config.js", () => ({ resolveRemoteCatalogUrl: vi.fn() }));
vi.mock("../model-catalog/remote-overlay.js", () => ({ checkRemoteModelCatalogUpdate: vi.fn() }));
vi.mock("../model-catalog/remote-refresh.js", () => ({
  refreshRemoteModelCatalog: vi.fn(),
  REMOTE_MODEL_CATALOG_TTL_MS: 21_600_000,
}));
vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));
vi.mock("./restart-sentinel.js", () => ({ readVerifiedGitUpdateReceipt: vi.fn(async () => null) }));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn() }));
vi.mock("./update-check.js", () => ({
  checkUpdateStatus: vi.fn(),
  compareSemverStrings: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));
vi.mock("./update-git-metadata.js", () => ({ resolveDevGitCommits: vi.fn() }));
vi.mock("./update-startup-auto-run.js", () => ({
  runCampaignUpdate: vi.fn(async () => "handoff"),
}));
vi.mock("./gateway-active-work.js", () => ({
  createGatewayActiveWorkSnapshot: vi.fn(() => ({ idle: true })),
}));
vi.mock("./gateway-supervision.js", () => ({
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON: "external-supervisor-update-required",
  isGatewayExternallySupervised: vi.fn(() => false),
}));

function mockDevGitStatus(params?: Parameters<typeof createDevGitStatus>[0]) {
  const status = createDevGitStatus(params);
  vi.mocked(checkUpdateStatus).mockResolvedValue(status);
  return status;
}

function runGatewayUpdateCheck({
  cfg,
  ...params
}: Omit<Parameters<typeof runGatewayUpdateCheckOwner>[0], "getConfig"> & { cfg: OpenClawConfig }) {
  return runGatewayUpdateCheckOwner({ ...params, getConfig: () => cfg });
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

  it("refreshes the inferred Dev channel for a configless Git installation", async () => {
    mockDevGitStatus({ behind: 3 });

    await refreshGatewayUpdateStatus({});

    expect(checkUpdateStatus).toHaveBeenCalledWith({
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
    });
    expect(getUpdateSchedule()).toMatchObject({
      channel: "dev",
      install: { kind: "git", git: { status: "behind", commitsBehind: 3 } },
      target: { kind: "git", upstreamSha: "upstream-sha", commitsBehind: 3 },
    });
    expect(getUpdateAvailable()).toMatchObject({ upstreamSha: "upstream-sha", commitsBehind: 3 });
  });

  it("publishes a configless Git refresh and projects the current automatic-update policy", async () => {
    mockDevGitStatus({ behind: 2 });
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "dev", auto: { enabled: true } } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });
    const schedule = getUpdateSchedule();
    expect(schedule?.campaign?.state).toBe("countdown");
    mockDevGitStatus({
      behind: 3,
      upstreamSha: "new-upstream-sha",
      repositoryUrl: "https://github.com/example/openclaw",
    });

    await refreshGatewayUpdateStatus({});

    expect(checkUpdateStatus).toHaveBeenCalledWith({
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
    });
    expect(getGatewayUpdateSchedule({}, "dev")).toEqual({
      ...schedule,
      autoEnabled: false,
      campaign: undefined,
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
    expect(getUpdateAvailable()).toMatchObject({
      upstreamSha: "new-upstream-sha",
      commitsBehind: 3,
      repositoryUrl: "https://github.com/example/openclaw",
    });
  });

  it("rearms the announced campaign for the latest target on manual Dev refresh", async () => {
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
    mockDevGitStatus({ upstreamSha: "old-upstream" });
    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");

    mockDevGitStatus({
      upstreamSha: "new-upstream",
      behind: 4,
      repositoryUrl: "https://github.com/example/openclaw",
    });
    await refreshGatewayUpdateStatus(cfg);

    expect(getUpdateAvailable()).toMatchObject({
      currentSha: "current-sha",
      upstreamSha: "new-upstream",
      repositoryUrl: "https://github.com/example/openclaw",
      commitsBehind: 4,
    });
    expect(getUpdateSchedule()?.target).toEqual({
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "new-upstream",
      commitsBehind: 4,
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(runCampaignUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCampaignUpdate).toHaveBeenCalledOnce();
    expect(runCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "new-upstream",
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "new-upstream" },
      }),
    );
  });

  it.each(["Git fetch", "installation identity", "unidentified installation"])(
    "preserves an announced campaign when %s cannot establish a target",
    async (failure) => {
      const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
      mockDevGitStatus({ upstreamSha: "announced-upstream" });
      await runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      const announced = campaign.getState();
      const available = getUpdateAvailable();
      if (failure === "Git fetch") {
        mockDevGitStatus({ fetchOk: false, upstreamSha: null, ahead: null, behind: null });
      } else {
        vi.mocked(checkUpdateStatus).mockResolvedValue({
          root: null,
          installKind: "unknown",
          packageManager: "unknown",
          ...(failure === "installation identity"
            ? { error: { status: "failed" as const, message: "Installation probe failed" } }
            : {}),
        });
      }
      await expect(refreshGatewayUpdateStatus(cfg)).rejects.toThrow("could not be checked");
      expect(campaign.getState()).toBe(announced);
      expect(getUpdateAvailable()).toBe(available);
      expect(getUpdateSchedule()?.target).toMatchObject({ upstreamSha: "announced-upstream" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runCampaignUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ version: "announced-upstream" }),
      );
    },
  );

  it.each(["package", "host", "immutable"] as const)(
    "retires an announced Git campaign when discovery identifies a %s install",
    async (installKind) => {
      const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
      mockDevGitStatus({ upstreamSha: "obsolete-git-target" });
      await runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      expect(campaign.getState()?.state).toBe("countdown");
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/opt/openclaw",
        installKind,
        packageManager: "npm",
      });

      await refreshGatewayUpdateStatus(cfg);

      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(campaign.getState()).toBeUndefined();
      expect(lifecycle.installStatus?.status.installKind).toBe(installKind);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runCampaignUpdate).not.toHaveBeenCalled();
    },
  );

  it("preserves Dev package availability during an interactive checkout check", async () => {
    const available = { currentVersion: "1.0.0", latestVersion: "1.1.0", channel: "dev" as const };
    const schedule = {
      channel: "dev" as const,
      autoEnabled: false,
      target: { kind: "package" as const, version: "1.1.0" },
    };
    setUpdateAvailableCache({ next: available });
    setUpdateScheduleCache({ next: schedule });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    });

    await refreshGatewayUpdateStatus({ update: { channel: "dev" } });

    expect(getUpdateAvailable()).toBe(available);
    expect(getUpdateSchedule()).toEqual({ ...schedule, install: { kind: "package" } });
  });

  it("does not publish an old Dev refresh over a replacement channel", async () => {
    const oldGitStatus = mockDevGitStatus();
    const entered = createDeferred();
    const discovery = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
      entered.resolve();
      return discovery.promise;
    });
    const refresh = refreshGatewayUpdateStatus({ update: { channel: "dev" } }).catch(
      (error: unknown) => error,
    );
    try {
      await entered.promise;

      await runGatewayUpdateCheck({
        cfg: { update: { channel: "beta", checkOnStart: false } },
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      const replacementSchedule = getUpdateSchedule();
      discovery.resolve(oldGitStatus);
      expect(await refresh).toEqual(
        expect.objectContaining({ message: expect.stringContaining("superseded") }),
      );

      expect(getUpdateSchedule()).toEqual(replacementSchedule);
    } finally {
      discovery.resolve(oldGitStatus);
      await refresh;
    }
  });

  it.each(["stable", "beta", "dev"] as const)(
    "does not supersede an active %s package check with an availability-preserving manual refresh",
    async (channel) => {
      const cfg = { update: { channel } };
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/opt/openclaw",
        installKind: "package",
        packageManager: "npm",
      });
      vi.mocked(compareSemverStrings).mockReturnValue(-1);
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: channel, version: "9.0.0" });
      const entered = createDeferred();
      const telemetry = createDeferred<Awaited<ReturnType<typeof checkTelemetryUpdate>>>();
      vi.mocked(checkTelemetryUpdate).mockImplementationOnce(() => {
        entered.resolve();
        return telemetry.promise;
      });
      const background = runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      try {
        await entered.promise;
        await refreshGatewayUpdateStatus(cfg);
        telemetry.resolve({ version: "9.0.0" });
        await background;
        expect(getUpdateAvailable()?.latestVersion).toBe("9.0.0");
        expect(getUpdateSchedule()?.target).toEqual({ kind: "package", version: "9.0.0" });
      } finally {
        telemetry.resolve({ version: "9.0.0" });
        await background;
      }
    },
  );

  it.each([
    { channel: "stable", stage: "initialization" },
    { channel: "beta", stage: "initialization" },
    { channel: "stable", stage: "telemetry" },
    { channel: "beta", stage: "telemetry" },
  ] as const)(
    "does not publish an old $channel package target after a manual Dev transition during $stage",
    async ({ channel, stage }) => {
      let cfg: OpenClawConfig = { update: { channel } };
      const installed: UpdateCheckResult = {
        root: "/opt/openclaw",
        installKind: "package",
        packageManager: "npm",
      };
      vi.mocked(checkUpdateStatus).mockResolvedValue(installed);
      vi.mocked(compareSemverStrings).mockReturnValue(-1);
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: channel, version: "9.0.0" });
      const entered = createDeferred();
      const identity = createDeferred<UpdateCheckResult>();
      const telemetry = createDeferred<Awaited<ReturnType<typeof checkTelemetryUpdate>>>();
      if (stage === "initialization") {
        vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
          entered.resolve();
          return identity.promise;
        });
      } else {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(() => {
          entered.resolve();
          return telemetry.promise;
        });
      }
      const background = runGatewayUpdateCheckOwner({
        getConfig: () => cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      try {
        await entered.promise;
        cfg = { update: { channel: "dev" } };
        await refreshGatewayUpdateStatus(cfg);
        const schedule = getUpdateSchedule();
        const available = getUpdateAvailable();
        expect(schedule?.channel).toBe("dev");

        identity.resolve(installed);
        telemetry.resolve({ version: "9.0.0" });
        await background;
        expect(getUpdateSchedule()).toEqual(schedule);
        expect(getUpdateAvailable()).toEqual(available);
      } finally {
        identity.resolve(installed);
        telemetry.resolve({ version: "9.0.0" });
        await background;
      }
    },
  );

  it.each(["stable", "beta"] as const)(
    "retires a cached %s package offer when an interactive refresh switches to Dev",
    async (channel) => {
      setUpdateAvailableCache({
        next: { currentVersion: "1.0.0", latestVersion: "9.0.0", channel },
      });
      setUpdateScheduleCache({
        next: { channel, autoEnabled: false, target: { kind: "package", version: "9.0.0" } },
      });
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/opt/openclaw",
        installKind: "package",
        packageManager: "npm",
      });

      await refreshGatewayUpdateStatus({ update: { channel: "dev" } });

      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()).toEqual({
        channel: "dev",
        autoEnabled: false,
        install: { kind: "package" },
      });
    },
  );

  it.each(["telemetry", "registry"] as const)(
    "does not publish old package %s after manual discovery adopts a Git checkout",
    async (stage) => {
      const cfg = { update: { channel: "dev" as const } };
      const entered = createDeferred();
      const telemetry = createDeferred<null>();
      const registry = createDeferred<Awaited<ReturnType<typeof resolveNpmChannelTag>>>();
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/opt/openclaw",
        installKind: "package",
        packageManager: "npm",
      });
      vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "dev", version: "9.0.0" });
      if (stage === "telemetry") {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(() => {
          entered.resolve();
          return telemetry.promise;
        });
      } else {
        vi.mocked(resolveNpmChannelTag).mockImplementationOnce(() => {
          entered.resolve();
          return registry.promise;
        });
      }
      const background = runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      try {
        await entered.promise;
        mockDevGitStatus({ upstreamSha: "fresh-git-target" });
        await refreshGatewayUpdateStatus(cfg);
        telemetry.resolve(null);
        registry.resolve({ tag: "dev", version: "9.0.0" });
        await background;
        expect(getUpdateAvailable()?.upstreamSha).toBe("fresh-git-target");
        expect(getUpdateSchedule()?.target).toMatchObject({
          kind: "git",
          upstreamSha: "fresh-git-target",
        });
        expect(await lifecycle.initialize()).toBe(lifecycle.installStatus);
        expect(lifecycle.installStatus?.status.installKind).toBe("git");
        expect(resolveNpmChannelTag).toHaveBeenCalledTimes(stage === "registry" ? 1 : 0);
      } finally {
        telemetry.resolve(null);
        registry.resolve({ tag: "dev", version: "9.0.0" });
        await background;
      }
    },
  );

  it("publishes manual target changes through the lifecycle callbacks", async () => {
    const onUpdateAvailableChange = vi.fn();
    const onUpdateScheduleChange = vi.fn();
    lifecycle = createGatewayUpdateLifecycle(scheduler, {
      onUpdateAvailableChange,
      onUpdateScheduleChange,
    });
    await refreshGatewayUpdateStatus({ update: { channel: "dev" } });
    expect(onUpdateAvailableChange).toHaveBeenLastCalledWith(getUpdateAvailable());
    expect(onUpdateScheduleChange).toHaveBeenLastCalledWith(getUpdateSchedule());

    mockDevGitStatus({ behind: 0 });
    await refreshGatewayUpdateStatus({ update: { channel: "dev" } });
    expect(onUpdateAvailableChange).toHaveBeenLastCalledWith(null);
    expect(onUpdateScheduleChange).toHaveBeenLastCalledWith(getUpdateSchedule());
  });

  it.each([
    { name: "current", git: { behind: 0 }, status: "current" },
    { name: "ahead", git: { ahead: 2, behind: 0 }, status: "ahead" },
    {
      name: "failed fetch",
      git: { fetchOk: false, upstreamSha: null, ahead: null, behind: null },
      status: "unavailable",
    },
    { name: "unverified fetch", git: { fetchOk: null }, status: "unavailable" },
    { name: "Git probe error", git: { error: "git unavailable" }, status: "unavailable" },
    { name: "missing upstream", git: { upstream: null }, status: "unavailable" },
    { name: "missing upstream SHA", git: { upstreamSha: null }, status: "unavailable" },
    { name: "missing comparison", git: { ahead: null, behind: null }, status: "unavailable" },
  ])(
    "reconciles a $name manual Dev refresh without treating failure as absence",
    async ({ git, status }) => {
      const cfg = { update: { channel: "dev" as const } };
      mockDevGitStatus({ upstreamSha: "old-upstream" });
      await runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      expect(getUpdateAvailable()?.upstreamSha).toBe("old-upstream");

      const checked = createDevGitStatus();
      vi.mocked(checkUpdateStatus).mockResolvedValue({
        ...checked,
        git: { ...checked.git, ...git },
      });
      const refresh = refreshGatewayUpdateStatus(cfg);
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

  it.each([
    { channel: "stable", stage: "initialization" },
    { channel: "beta", stage: "initialization" },
    { channel: "stable", stage: "telemetry" },
    { channel: "beta", stage: "telemetry" },
  ] as const)(
    "keeps a manual Dev target after an old $channel check finishes $stage",
    async ({ channel, stage }) => {
      let cfg: OpenClawConfig = { update: { channel } };
      const oldStatus = mockDevGitStatus({ upstreamSha: "old-upstream" });
      const entered = createDeferred();
      const discovery = createDeferred<UpdateCheckResult>();
      const telemetry = createDeferred<null>();
      if (stage === "initialization") {
        vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
          entered.resolve();
          return discovery.promise;
        });
      } else {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(() => {
          entered.resolve();
          return telemetry.promise;
        });
      }
      const background = runGatewayUpdateCheckOwner({
        getConfig: () => cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      try {
        await entered.promise;
        cfg = { update: { channel: "dev" } };
        mockDevGitStatus({ upstreamSha: "fresh-dev-target", behind: 4 });
        await refreshGatewayUpdateStatus(cfg);
        const latestSchedule = getUpdateSchedule();
        const latestAvailability = getUpdateAvailable();
        expect(latestSchedule?.target).toMatchObject({ upstreamSha: "fresh-dev-target" });

        discovery.resolve(oldStatus);
        telemetry.resolve(null);
        await background;

        expect(getUpdateSchedule()).toEqual(latestSchedule);
        expect(getUpdateAvailable()).toEqual(latestAvailability);
        if (stage === "initialization") {
          expect(lifecycle.installStatus?.status.git?.upstreamSha).toBe("fresh-dev-target");
        }
        expect(runCampaignUpdate).not.toHaveBeenCalled();
      } finally {
        discovery.resolve(oldStatus);
        telemetry.resolve(null);
        await background;
      }
    },
  );

  it.each(["initialization", "fetch", "telemetry", "metadata"] as const)(
    "keeps a newer manual target when old background %s finishes last",
    async (stage) => {
      const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
      const oldStatus = mockDevGitStatus({ upstreamSha: "old-upstream" });
      const started = createDeferred();
      const remote = createDeferred<UpdateCheckResult>();
      const telemetry = createDeferred<null>();
      const metadata = createDeferred<Awaited<ReturnType<typeof resolveDevGitCommits>>>();
      if (stage === "initialization" || stage === "fetch") {
        vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit }) => {
          if (fetchGit || stage === "initialization") {
            started.resolve();
            return remote.promise;
          }
          return Promise.resolve(oldStatus);
        });
      } else if (stage === "telemetry") {
        vi.mocked(checkTelemetryUpdate).mockImplementationOnce(() => {
          started.resolve();
          return telemetry.promise;
        });
      } else {
        vi.mocked(resolveDevGitCommits).mockImplementationOnce(() => {
          started.resolve();
          return metadata.promise;
        });
      }
      const background = runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      try {
        await started.promise;
        mockDevGitStatus({ upstreamSha: "new-upstream", behind: 4 });
        await refreshGatewayUpdateStatus(cfg);
        const latestSchedule = getUpdateSchedule();
        const latestAvailability = getUpdateAvailable();
        expect(latestSchedule?.target).toMatchObject({ upstreamSha: "new-upstream" });

        remote.resolve(oldStatus);
        telemetry.resolve(null);
        metadata.resolve([]);
        await background;

        expect(getUpdateSchedule()).toEqual(latestSchedule);
        expect(getUpdateAvailable()).toEqual(latestAvailability);
        expect(campaign.getState()?.state).toBe("countdown");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runCampaignUpdate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            version: "new-upstream",
            devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "new-upstream" },
          }),
        );
      } finally {
        remote.resolve(oldStatus);
        telemetry.resolve(null);
        metadata.resolve([]);
        await background;
      }
    },
  );

  it("rejects an older manual observation after an overlapping background target publishes", async () => {
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
    const fetching = createDeferred();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit }) => {
      if (fetchGit) {
        fetching.resolve();
        return remote.promise;
      }
      return Promise.resolve(createDevGitStatus());
    });
    const background = runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });
    const metadataStarted = createDeferred();
    const metadata = createDeferred<Awaited<ReturnType<typeof resolveDevGitCommits>>>();
    try {
      await fetching.promise;
      mockDevGitStatus({ upstreamSha: "older-manual", behind: 2 });
      vi.mocked(resolveDevGitCommits).mockImplementationOnce(() => {
        metadataStarted.resolve();
        return metadata.promise;
      });
      const manual = refreshGatewayUpdateStatus(cfg).then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      await metadataStarted.promise;
      remote.resolve(createDevGitStatus({ upstreamSha: "newer-background", behind: 4 }));
      await background;
      const latest = getUpdateSchedule();
      expect(latest?.target).toMatchObject({ upstreamSha: "newer-background" });
      metadata.resolve([]);
      expect(await manual).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("superseded") }),
      });
      expect(getUpdateSchedule()).toEqual(latest);
      expect(getUpdateAvailable()?.upstreamSha).toBe("newer-background");
    } finally {
      remote.resolve(createDevGitStatus());
      metadata.resolve([]);
      await background;
    }
  });

  it("does not confirm freshness when newer background discovery supersedes a manual check", async () => {
    const cfg = { update: { channel: "dev" as const } };
    const started = createDeferred();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
      started.resolve();
      return remote.promise;
    });
    const refresh = refreshGatewayUpdateStatus(cfg).catch((error: unknown) => error);
    try {
      await started.promise;
      mockDevGitStatus({ upstreamSha: "new-upstream" });
      await runGatewayUpdateCheck({
        cfg,
        log: { info: vi.fn() },
        isNixMode: false,
        allowInTests: true,
      });
      remote.resolve(createDevGitStatus({ upstreamSha: "old-upstream" }));
      expect(await refresh).toEqual(
        expect.objectContaining({ message: expect.stringContaining("superseded") }),
      );
      expect(getUpdateAvailable()?.upstreamSha).toBe("new-upstream");
    } finally {
      remote.resolve(createDevGitStatus());
      await refresh;
    }
  });

  it("preserves the admitted target when a campaign starts applying during manual Dev refresh", async () => {
    const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
    mockDevGitStatus({ upstreamSha: "admitted-upstream" });
    await runGatewayUpdateCheck({
      cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
    });
    const started = createDeferred();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(() => {
      started.resolve();
      return remote.promise;
    });
    const refresh = refreshGatewayUpdateStatus(cfg).catch((error: unknown) => error);
    try {
      await started.promise;
      expect(campaign.adopt().status).toBe("adopted");
      const applyingSchedule = getUpdateSchedule();
      const applyingAvailability = getUpdateAvailable();
      remote.resolve(createDevGitStatus({ upstreamSha: "new-upstream", behind: 4 }));
      expect(await refresh).toEqual(
        expect.objectContaining({ message: expect.stringContaining("superseded") }),
      );

      expect(getUpdateSchedule()).toEqual(applyingSchedule);
      expect(getUpdateAvailable()).toEqual(applyingAvailability);
    } finally {
      remote.resolve(createDevGitStatus());
      await refresh;
    }
  });

  it("lets progressing discovery outlive the former quick-check budget", async () => {
    mockDevGitStatus();
    const started = createDeferred<AbortSignal | undefined>();
    const remote = createDeferred<UpdateCheckResult>();
    vi.mocked(checkUpdateStatus).mockImplementationOnce(({ signal }) => {
      started.resolve(signal);
      return remote.promise;
    });
    let settled = false;
    const refresh = refreshGatewayUpdateStatus({ update: { channel: "dev" } }).catch(
      (error: unknown) => error,
    );
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
