import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import { checkUpdateStatus } from "./update-check.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import { createGatewayUpdateCheck, resetUpdateAvailableStateForTest } from "./update-startup.js";
import { getUpdateSchedule } from "./update-status-state.js";

vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(),
}));
vi.mock("./restart-sentinel.js", async (original) => ({
  ...(await original<typeof import("./restart-sentinel.js")>()),
  readVerifiedGitUpdateReceipt: async () => null,
}));
vi.mock("./update-check.js", async (original) => ({
  ...(await original<typeof import("./update-check.js")>()),
  checkUpdateStatus: vi.fn(),
}));
vi.mock("./gateway-supervision.js", async (original) => ({
  ...(await original<typeof import("./gateway-supervision.js")>()),
  isGatewayExternallySupervised: () => false,
}));
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: async () => null }));
vi.mock("./update-git-metadata.js", () => ({ resolveDevGitCommits: async () => [] }));
vi.mock("../model-catalog/remote-refresh.js", () => ({
  REMOTE_MODEL_CATALOG_TTL_MS: 6 * 60 * 60_000,
  refreshRemoteModelCatalog: async () => ({ status: "disabled" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it("reports a failed background update check and keeps its next check scheduled", async () => {
  const state = await createOpenClawTestState({
    label: "update-startup-failure-visibility",
    env: { NODE_ENV: "production", VITEST: undefined, OPENCLAW_NO_AUTO_UPDATE: undefined },
  });
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const lifecycle = createGatewayUpdateLifecycle(scheduler);
  const info = vi.fn();
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  vi.mocked(checkUpdateStatus).mockRejectedValue(new Error("synthetic update discovery failure"));
  const check = createGatewayUpdateCheck({
    lifecycle,
    getConfig: () => ({}),
    log: { info },
    isNixMode: false,
    applyRemoteCatalogUpdate: async () => "unchanged",
  });
  try {
    check.start();
    await clock.advanceBy(0);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "update check failed; retrying at the next scheduled check",
      { error: "Error: synthetic update discovery failure" },
    );
    expect(checkUpdateStatus).toHaveBeenCalledOnce();
    await clock.advanceBy(24 * 60 * 60_000);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(2);
  } finally {
    await Promise.all([check.stop(), scheduler.stop()]);
    resetUpdateAvailableStateForTest(scheduler);
    await closeStateDatabaseForTest();
    await state.cleanup();
  }
});

it("returns cleanup before slow dev git discovery schedules a campaign", async ({ signal }) => {
  const remoteFetchDelayMs = 65_653;
  const entered = createDeferred();
  const remoteFinished = createDeferred();
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  vi.mocked(checkUpdateStatus).mockImplementation(({ fetchGit, timeoutMs }) => {
    const isRemoteFetch = fetchGit === true;
    const effectiveTimeoutMs = timeoutMs ?? (isRemoteFetch ? 120_000 : 6000);
    const remoteFetchFinished = isRemoteFetch && effectiveTimeoutMs >= remoteFetchDelayMs;
    const status = createDevGitStatus({
      upstreamSha: remoteFetchFinished ? "upstream-sha" : null,
      ahead: remoteFetchFinished ? 0 : null,
      behind: remoteFetchFinished ? 2 : null,
      fetchOk: isRemoteFetch ? remoteFetchFinished : null,
    });
    if (!isRemoteFetch) {
      return Promise.resolve(status);
    }
    entered.resolve();
    return remoteFinished.promise.then(() => status);
  });
  const state = await createOpenClawTestState({
    label: "update-startup-discovery",
    env: { NODE_ENV: "production", VITEST: undefined, OPENCLAW_NO_AUTO_UPDATE: undefined },
  });
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  resetUpdateAvailableStateForTest(scheduler);
  let stop: (() => Promise<void>) | undefined;
  let checking: ReturnType<typeof clock.advanceBy> = undefined;

  try {
    const check = createGatewayUpdateCheck({
      lifecycle: createGatewayUpdateLifecycle(scheduler),
      getConfig: () => ({ update: { channel: "dev", auto: { enabled: true } } }),
      log: { info: vi.fn() },
      isNixMode: false,
      applyRemoteCatalogUpdate: async () => "unchanged",
    });
    stop = check.stop;
    check.start();
    checking = clock.advanceBy(0);

    expect(stop).toEqual(expect.any(Function));
    await withinTest(entered.promise, signal);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    expect(checkUpdateStatus).toHaveBeenNthCalledWith(1, {
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      timeoutMs: resolveGatewayStartupTiming().deadlineMs,
      onGitProbeTimeout: expect.any(Function),
      fetchGit: false,
      includeRegistry: false,
      useDetachedDevUpstream: true,
    });
    expect(checkUpdateStatus).toHaveBeenNthCalledWith(2, {
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      fetchGit: true,
      includeRegistry: false,
      useDetachedDevUpstream: true,
    });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();

    await clock.advanceBy(remoteFetchDelayMs);
    remoteFinished.resolve();
    await checking;
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    expect(getUpdateSchedule()?.install?.git).toMatchObject({
      status: "behind",
      commitsBehind: 2,
    });
  } finally {
    remoteFinished.resolve();
    await Promise.all([checking, stop?.()]);
    await scheduler.stop();
    resetUpdateAvailableStateForTest(scheduler);
    await closeStateDatabaseForTest();
    await state.cleanup();
  }
});
