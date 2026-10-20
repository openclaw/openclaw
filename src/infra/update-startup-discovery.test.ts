import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import type { OpenClawConfig } from "../config/config.js";
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

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let check: ReturnType<typeof createGatewayUpdateCheck>;
let config: OpenClawConfig;
const info = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  const state = await createOpenClawTestState({
    label: "update-startup-discovery",
    env: { NODE_ENV: "production", VITEST: undefined, OPENCLAW_NO_AUTO_UPDATE: undefined },
  });
  clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  config = {};
  resetUpdateAvailableStateForTest(scheduler);
  vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
  check = createGatewayUpdateCheck({
    lifecycle: createGatewayUpdateLifecycle(scheduler),
    getConfig: () => config,
    log: { info },
    isNixMode: false,
    applyRemoteCatalogUpdate: async () => "unchanged",
  });
  return async () => {
    await Promise.all([check.stop(), scheduler.stop()]);
    resetUpdateAvailableStateForTest(scheduler);
    await closeStateDatabaseForTest();
    await state.cleanup();
  };
});

it("reports a failed background update check and keeps its next check scheduled", async () => {
  vi.mocked(checkUpdateStatus).mockRejectedValue(new Error("synthetic update discovery failure"));
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
});

it("returns cleanup before slow dev git discovery schedules a campaign", async ({ signal }) => {
  const remoteFetchDelayMs = 65_653;
  const entered = createDeferred();
  const remoteFinished = createDeferred();
  config = { update: { channel: "dev", auto: { enabled: true } } };
  vi.mocked(checkUpdateStatus).mockImplementation(async ({ fetchGit }) => {
    if (!fetchGit) {
      return createDevGitStatus({ upstreamSha: null, ahead: null, behind: null, fetchOk: null });
    }
    entered.resolve();
    await remoteFinished.promise;
    return createDevGitStatus();
  });
  let checking: ReturnType<typeof clock.advanceBy> = undefined;

  try {
    check.start();
    checking = clock.advanceBy(0);

    expect(check.stop).toEqual(expect.any(Function));
    await withinTest(entered.promise, signal);
    const common = {
      root: "/opt/openclaw",
      signal: expect.any(AbortSignal),
      includeRegistry: false,
      useDetachedDevUpstream: true,
    };
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    expect(checkUpdateStatus).toHaveBeenNthCalledWith(1, {
      ...common,
      timeoutMs: resolveGatewayStartupTiming().deadlineMs,
      onGitProbeTimeout: expect.any(Function),
      fetchGit: false,
    });
    expect(checkUpdateStatus).toHaveBeenNthCalledWith(2, { ...common, fetchGit: true });
    expect(getUpdateSchedule()?.campaign).toBeUndefined();

    await clock.advanceBy(remoteFetchDelayMs);
    remoteFinished.resolve();
    await checking;
    expect(getUpdateSchedule()).toMatchObject({
      campaign: { state: "countdown" },
      install: { git: { status: "behind", commitsBehind: 2 } },
    });
  } finally {
    remoteFinished.resolve();
    await Promise.all([checking, check.stop()]);
  }
});
