import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { gatewayUpdateCampaign } from "./update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import { checkUpdateStatus, type UpdateCheckResult } from "./update-check.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";
import { runCampaignUpdate } from "./update-startup-auto-run.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import {
  refreshGatewayUpdateStatus,
  runGatewayUpdateCheck as runGatewayUpdateCheckOwner,
} from "./update-startup.js";
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
    vi.mocked(checkUpdateStatus).mockReset().mockResolvedValue(createDevGitStatus());
    vi.mocked(checkTelemetryUpdate).mockReset().mockResolvedValue(null);
    vi.mocked(resolveDevGitCommits).mockReset().mockResolvedValue([]);
    vi.mocked(runCampaignUpdate).mockClear();
    resetUpdateStatusState();
    lifecycle = createGatewayUpdateLifecycle();
    lifecycle.campaign = gatewayUpdateCampaign;
  });

  afterEach(async () => {
    await lifecycle.stop();
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

  it("publishes the latest target on manual Dev refresh without applying the old campaign", async () => {
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
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCampaignUpdate).not.toHaveBeenCalled();
  });

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
    expect(getUpdateSchedule()).toBe(schedule);
  });

  it("publishes manual target changes through the lifecycle callbacks", async () => {
    const onUpdateAvailableChange = vi.fn();
    const onUpdateScheduleChange = vi.fn();
    lifecycle = createGatewayUpdateLifecycle({ onUpdateAvailableChange, onUpdateScheduleChange });
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
  ])("clears a stale target after a $name manual Dev refresh", async ({ git, status }) => {
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
    vi.mocked(checkUpdateStatus).mockResolvedValue({ ...checked, git: { ...checked.git, ...git } });
    const refresh = refreshGatewayUpdateStatus(cfg);
    if (status === "unavailable") {
      await expect(refresh).rejects.toThrow("The latest Dev update could not be checked");
    } else {
      await refresh;
    }

    expect(getUpdateAvailable()).toBeNull();
    expect(getUpdateSchedule()?.target).toBeUndefined();
    expect(getUpdateSchedule()?.install?.git?.status).toBe(status);
  });

  it.each(["fetch", "telemetry", "metadata"] as const)(
    "keeps a newer manual target when old background %s finishes last",
    async (stage) => {
      const cfg = { update: { channel: "dev" as const, auto: { enabled: true } } };
      const oldStatus = mockDevGitStatus({ upstreamSha: "old-upstream" });
      const started = createDeferred();
      const remote = createDeferred<UpdateCheckResult>();
      const telemetry = createDeferred<null>();
      const metadata = createDeferred<Awaited<ReturnType<typeof resolveDevGitCommits>>>();
      if (stage === "fetch") {
        vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit }) => {
          if (fetchGit) {
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
        expect(gatewayUpdateCampaign.getState()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runCampaignUpdate).not.toHaveBeenCalled();
      } finally {
        remote.resolve(oldStatus);
        telemetry.resolve(null);
        metadata.resolve([]);
        await background;
      }
    },
  );

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
    const refresh = refreshGatewayUpdateStatus(cfg);
    try {
      await started.promise;
      expect(gatewayUpdateCampaign.adopt().status).toBe("adopted");
      const applyingSchedule = getUpdateSchedule();
      const applyingAvailability = getUpdateAvailable();
      remote.resolve(createDevGitStatus({ upstreamSha: "new-upstream", behind: 4 }));
      await refresh;

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
