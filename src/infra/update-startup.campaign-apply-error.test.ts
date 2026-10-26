import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as machineState from "../state/config-machine-state-async.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as sentinel from "./restart-sentinel.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import { checkUpdateStatus } from "./update-check.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import {
  containingObject,
  matchingObject,
  idleActiveWorkInspectors,
} from "./update-startup-suite.test-support.js";
import { createGatewayUpdateCheck } from "./update-startup.js";
import { getUpdateSchedule, resetUpdateStatusState } from "./update-status-state.js";

vi.mock("./openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));

vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus: vi.fn(),
}));

vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn(async () => null) }));
vi.mock("../model-catalog/remote-refresh.js", async (original) => ({
  ...(await original<typeof import("../model-catalog/remote-refresh.js")>()),
  refreshRemoteModelCatalog: async () => ({ status: "disabled" }),
}));

describe("scheduled update discovery and application", () => {
  let testState: OpenClawTestState;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let lifecycle: UpdateCheckLifecycle;
  let check: ReturnType<typeof createGatewayUpdateCheck>;
  let config: OpenClawConfig;
  const info = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler(clock.clock));
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-update-campaign-apply-",
      env: {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        NODE_ENV: "production",
        VITEST: undefined,
      },
    });
    config = {};
    check = createGatewayUpdateCheck({
      lifecycle,
      getConfig: () => config,
      log: { info },
      isNixMode: false,
      applyRemoteCatalogUpdate: async () => "unchanged",
    });
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
    check.start();
    const checking = clock.advanceBy(0);
    try {
      await withinTest(entered.promise, signal);
      expect(getUpdateSchedule()?.campaign).toBeUndefined();
      await clock.advanceBy(65_653);
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

  afterEach(async () => {
    await lifecycle.stop();
    await lifecycle.scheduler.stop();
    resetUpdateStatusState();
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    await testState.cleanup();
  });

  it.each([
    { at: "sentinel-read", code: "SQLITE_READONLY", message: "sentinel transaction refused" },
    { at: "state-write", code: "ERR_SQLITE_ERROR", message: "attempt state write refused" },
    { at: "sentinel-read", code: undefined, message: "sentinel transaction unavailable" },
  ] as const)("records and logs $at failure ($code)", async ({ at, code, message }) => {
    vi.mocked(checkUpdateStatus).mockResolvedValue(createDevGitStatus());
    const { runGatewayUpdateCheck } = await import("./update-startup.js");
    const autoRun = await import("./update-startup-auto-run.js");
    const runAutoUpdate = vi
      .spyOn(autoRun, "runAutoUpdateCommand")
      .mockResolvedValue({ status: "handoff" });
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      getConfig: () => ({ update: { channel: "dev", auto: { enabled: true } } }),
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    const error = Object.assign(new Error(message), { code });
    if (at === "sentinel-read") {
      vi.spyOn(sentinel, "readRestartSentinelSnapshot").mockRejectedValue(error);
    } else {
      vi.spyOn(machineState, "writeConfigMachineStateAsync").mockImplementation(() => {
        throw error;
      });
    }

    await clock.advanceBy(60_000);

    const run = getUpdateRun(listUpdateRuns()[0]?.runId ?? "");
    const diagnostic = code ? `${message} | ${code}` : message;
    expect(run).toMatchObject({
      status: "failed",
      reason: code ?? "unexpected-error",
      steps: containingObject({
        status: "failed",
        detail: diagnostic,
        failureFacts: matchingObject({ code: code ?? "Error", message: diagnostic }),
      }),
      verification: { rollbackOutcome: { status: "not-attempted" } },
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    const failureLog = log.info.mock.calls.find(([line]) => String(line).includes(message));
    expect(failureLog?.[1]).toMatchObject({ channel: "dev", forced: false, tag: "dev" });
  });
});
