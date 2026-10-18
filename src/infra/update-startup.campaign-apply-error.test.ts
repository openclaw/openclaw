import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { readUpdateRunStatus } from "./update-run-status.js";
import { createDevGitStatus } from "./update-startup-git.test-support.js";
import {
  containingObject,
  matchingObject,
  idleActiveWorkInspectors,
  expectIncludes,
  recordedFailureReport,
} from "./update-startup-suite.test-support.js";
import { getUpdateSchedule, resetUpdateStatusState } from "./update-status-state.js";

const fault = vi.hoisted((): { at?: "sentinel-read" | "state-write"; error?: Error } => ({}));

vi.mock("./restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./restart-sentinel.js")>();
  return {
    ...actual,
    readRestartSentinelSnapshot: async (
      ...args: Parameters<typeof actual.readRestartSentinelSnapshot>
    ) => {
      if (fault.at === "sentinel-read" && fault.error) {
        throw fault.error;
      }
      return await actual.readRestartSentinelSnapshot(...args);
    },
  };
});

vi.mock("../state/config-machine-state-async.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/config-machine-state-async.js")>();
  return {
    ...actual,
    writeConfigMachineStateAsync: (
      ...args: Parameters<typeof actual.writeConfigMachineStateAsync>
    ) => {
      if (fault.at === "state-write" && fault.error) {
        throw fault.error;
      }
      return actual.writeConfigMachineStateAsync(...args);
    },
  };
});

vi.mock("./openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));

vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("./update-triage.js", () => ({ runUpdateFailureTriage: vi.fn() }));

vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn(async () => null) }));

vi.mock("../model-catalog/remote-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-catalog/remote-refresh.js")>()),
  refreshRemoteModelCatalog: vi.fn(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
}));

describe("update campaign apply exception boundary", () => {
  let testState: OpenClawTestState;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let lifecycle: UpdateCheckLifecycle;

  beforeEach(async () => {
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
        NODE_ENV: "test",
        VITEST: undefined,
      },
    });
  });

  afterEach(async () => {
    delete fault.at;
    delete fault.error;
    await lifecycle.stop();
    await lifecycle.scheduler.stop();
    resetUpdateStatusState();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it.each([
    { at: "sentinel-read", code: "SQLITE_READONLY", message: "sentinel transaction refused" },
    { at: "state-write", code: "ERR_SQLITE_ERROR", message: "attempt state write refused" },
    { at: "sentinel-read", code: undefined, message: "sentinel transaction unavailable" },
  ] as const)("records and logs $at failure ($code)", async ({ at, code, message }) => {
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    vi.mocked(checkUpdateStatus).mockResolvedValue(createDevGitStatus());
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "dev", version: "99.0.0-dev.1" });
    const { runGatewayUpdateCheck } = await import("./update-startup.js");
    const runAutoUpdate = vi.fn(async () => ({ status: "handoff" as const }));
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      getConfig: () => ({ update: { channel: "dev", auto: { enabled: true } } }),
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");
    fault.at = at;
    fault.error = Object.assign(new Error(message), { code });

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
      target: { kind: "git", installationMethod: "git-checkout" },
      verification: { rollbackOutcome: { status: "not-attempted" } },
    });
    const runStatus = await readUpdateRunStatus();
    assert(!("runStatusError" in runStatus) && runStatus.lastRun);
    const { lastRun } = runStatus;
    expect(lastRun).toEqual(run);
    const report = renderUpdateRunReport(lastRun);
    expect(report.headline).toContain(code ?? "unexpected-error");
    expect(report.markdown).toContain(message);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    const { body } = await recordedFailureReport(lastRun, "git");
    expectIncludes(body, message, "git-checkout", "startup campaign does not roll back");
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    const failureLog = log.info.mock.calls.find(([line]) => String(line).includes(message));
    expect(failureLog?.[1]).toMatchObject({ channel: "dev", forced: false, tag: "dev" });
  });
});
