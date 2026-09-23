import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { UpdateCheckResult } from "./update-check.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { readUpdateRunStatus } from "./update-run-status.js";
import { getUpdateSchedule } from "./update-status-state.js";

const { fault } = vi.hoisted(
  (): {
    fault: { at?: "sentinel-read" | "state-write"; error?: Error };
  } => ({
    fault: {},
  }),
);

vi.mock("./restart-sentinel.js", async () => {
  const actual =
    await vi.importActual<typeof import("./restart-sentinel.js")>("./restart-sentinel.js");
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

vi.mock("../state/config-machine-state-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/config-machine-state-write.js")>();
  return {
    ...actual,
    writeConfigMachineState: (...args: Parameters<typeof actual.writeConfigMachineState>) => {
      if (fault.at === "state-write" && fault.error) {
        throw fault.error;
      }
      return actual.writeConfigMachineState(...args);
    },
  };
});

vi.mock("./openclaw-root.js", async () => ({
  ...(await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js")),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));

vi.mock("./update-check.js", async () => ({
  ...(await vi.importActual<typeof import("./update-check.js")>("./update-check.js")),
  checkUpdateStatus: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("./update-triage.js", () => ({ runUpdateFailureTriage: vi.fn() }));

vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn(async () => null) }));

vi.mock("../model-catalog/remote-refresh.js", async () => ({
  ...(await vi.importActual<typeof import("../model-catalog/remote-refresh.js")>(
    "../model-catalog/remote-refresh.js",
  )),
  refreshRemoteModelCatalog: vi.fn(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
}));

function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

describe("update campaign apply exception boundary", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
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
    const { resetUpdateAvailableStateForTest } = await import("./update-startup.js");
    resetUpdateAvailableStateForTest();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it.each([
    { at: "sentinel-read", code: "SQLITE_READONLY", message: "sentinel transaction refused" },
    { at: "state-write", code: "ERR_SQLITE_ERROR", message: "attempt state write refused" },
    { at: "sentinel-read", code: undefined, message: "sentinel transaction unavailable" },
  ] as const)("records and logs $at failure ($code)", async ({ at, code, message }) => {
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/opt/openclaw",
        sha: "current-sha",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        upstreamSource: "tracking",
        upstreamSha: "upstream-sha",
        commitAtMs: null,
        dirty: false,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
    } satisfies UpdateCheckResult);
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

    await vi.advanceTimersByTimeAsync(60_000);

    const runId = listUpdateRuns()[0]?.runId ?? "";
    const run = getUpdateRun(runId);
    const diagnostic = code ? `${message} | ${code}` : message;
    expect(run).toMatchObject({
      status: "failed",
      reason: code ?? "unexpected-error",
      steps: expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          detail: diagnostic,
          failureFacts: [expect.objectContaining({ code: code ?? "Error", message: diagnostic })],
        }),
      ]),
      target: { kind: "git", installationMethod: "git-checkout" },
      verification: { rollbackOutcome: { status: "not-attempted" } },
    });
    const runStatus = readUpdateRunStatus();
    assert(!("runStatusError" in runStatus));
    const { lastRun } = runStatus;
    expect(lastRun).toEqual(run);
    assert(lastRun);
    const report = renderUpdateRunReport(lastRun);
    expect(report.headline).toContain(code ?? "unexpected-error");
    expect(report.markdown).toContain(message);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    const prepared = await prepareUpdateFailureReport({
      attemptId: lastRun.runId,
      recordedRun: lastRun,
      result: {
        status: "error",
        mode: "git",
        reason: lastRun.reason ?? undefined,
        steps: [],
        durationMs: 0,
      },
    });
    expect(prepared.body).toContain(message);
    expect(prepared.body).toContain("git-checkout");
    expect(prepared.body).toContain("startup campaign does not roll back");
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    const failureLog = log.info.mock.calls.find(([line]) => String(line).includes(message));
    expect(failureLog).toBeDefined();
    expect(failureLog?.[1]).toMatchObject({ channel: "dev", forced: false, tag: "dev" });
  });
});
