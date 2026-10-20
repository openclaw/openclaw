import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunDiagnostics,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
function fixture(busyTimeoutMs?: number, trigger: "cli" | "api" = "cli") {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("update-diagnostics-") }, busyTimeoutMs };
  return { options, run: createUpdateRun({ trigger }, options) };
}
const recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" } as const;
const healthy = {
  serviceRunning: true,
  runningVersion: "2026.9.5",
  versionMatch: true,
  readyz: true,
  settled: true,
};
const observation = (exitCode: number | null) => ({
  name: "gateway recovery verification",
  command: "verify",
  cwd: "",
  durationMs: 0,
  exitCode,
});
function unexpected() {
  throw new Error("diagnostics were not recorded");
}

it.each(["failed", "succeeded", "skipped", "rolled-back"] as const)(
  "enriches only failed terminal diagnostics without replacing the %s outcome",
  (status) => {
    const { options, run } = fixture(undefined, "api");
    const original = { check: "managed-service", code: "EACCES", message: "Permission denied" };
    const late = { check: "managed-service", code: "handoff-permission-denied" };
    recordUpdateRunStep(
      run.runId,
      {
        step: "requested",
        status: "failed",
        detail: "original refusal",
        exitCode: 7,
        failureFacts: [original],
      },
      options,
    );
    const terminal = finishUpdateRun(run.runId, { status, reason: "original-outcome" }, options);
    const append = () =>
      recordUpdateRunDiagnostics(
        run.runId,
        {
          failure: {
            step: "requested",
            detail: "late refusal",
            exitCode: 9,
            failureFacts: [original, late],
          },
        },
        unexpected,
        options,
      );
    const recorded = append();
    expect(append()).toEqual(recorded);
    expect(recorded).toMatchObject({
      status,
      reason: "original-outcome",
      finishedAtMs: terminal.finishedAtMs,
      steps: [
        expect.objectContaining({
          ...terminal.steps[0],
          failureFacts: status === "failed" ? [original, late] : [original],
        }),
      ],
    });
  },
);

it("records serving health without replacing a persisted restart refusal", () => {
  const { options, run } = fixture();
  recordUpdateRunVerification(run.runId, { recovery }, options);
  const recorded = recordUpdateRunDiagnostics(
    run.runId,
    {
      recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
      verification: healthy,
      steps: [observation(0)],
    },
    unexpected,
    options,
  );
  expect(recorded?.verification).toEqual({ ...healthy, recovery });
  expect(renderUpdateRunReport(recorded!).markdown).toContain(
    "Recorded recovery: verified serving 2026.9.5; restart remains unsafe (runtime-verification-failed)",
  );
});

it.each([undefined, "active-mutation"] as const)(
  "preserves named data risk over an older refusal (%s) and healthy observation",
  (existingRisk) => {
    const { options, run } = fixture();
    recordUpdateRunVerification(
      run.runId,
      {
        recovery: {
          ...recovery,
          ...(existingRisk ? { dataAtRisk: existingRisk } : {}),
        },
      },
      options,
    );
    const incoming = {
      ...recovery,
      dataAtRisk: "unreadable-state",
    } as const;
    recordUpdateRunDiagnostics(
      run.runId,
      { recovery: incoming, verification: { serviceRunning: true, readyz: true } },
      () => {},
      options,
    );
    expect(getUpdateRun(run.runId, options)?.verification.recovery).toEqual({
      ...incoming,
      dataAtRisk: existingRisk ?? incoming.dataAtRisk,
    });
  },
);

it("keeps the first terminal receipt when a stale publisher carries success verification", () => {
  const { options, run } = fixture();
  const terminal = finishUpdateRun(
    run.runId,
    {
      status: "failed",
      reason: "doctor-failed",
      diagnostics: {
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      },
    },
    options,
  );
  const stale = finishUpdateRun(
    run.runId,
    {
      status: "succeeded",
      diagnostics: {
        recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
        verification: { readyz: true, settled: true, versionMatch: true },
      },
    },
    options,
  );
  expect(stale).toEqual(terminal);
  expect(getUpdateRun(run.runId, options)).toEqual(terminal);
});

it("keeps recovery observations atomic across a busy write without revising the failed outcome", () => {
  const { options, run } = fixture(0);
  recordUpdateRunVerification(
    run.runId,
    {
      booted: true,
      noticeDelivered: true,
      doctorHint: "run doctor",
      ...healthy,
      channelsReady: true,
      pluginErrors: [],
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
    options,
  );
  recordUpdateRunStep(
    run.runId,
    { step: "gateway recovery verification", status: "completed", exitCode: 0 },
    options,
  );
  finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" }, options);
  const before = getUpdateRun(run.runId, options);
  expect(before?.confirmedAtMs).toEqual(expect.any(Number));
  const warn = vi.fn();
  const recordPending = () =>
    recordUpdateRunDiagnostics(
      run.runId,
      (recorded) => ({
        recovery: recorded.recovery,
        verification: { readyz: false, settled: false },
        steps: [
          {
            ...observation(null),
            command: "gateway verification",
            advisory: { kind: "recoverable-maintenance", message: "Gateway readiness is pending" },
          },
        ],
      }),
      warn,
      options,
    );
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  try {
    writer.exec("BEGIN IMMEDIATE");
    recordPending();
    expect(warn).toHaveBeenCalledOnce();
    expect(getUpdateRun(run.runId, options)).toEqual(before);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  warn.mockClear();
  recordPending();
  expect(warn).not.toHaveBeenCalled();
  const after = getUpdateRun(run.runId, options);
  expect(after).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
    confirmedAtMs: null,
    verification: {
      booted: true,
      noticeDelivered: true,
      doctorHint: "run doctor",
      readyz: false,
      settled: false,
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
  });
  expect(after?.verification.runningVersion).toBeUndefined();
  expect(
    after?.steps.find((step) => step.step === "gateway recovery verification")?.exitCode,
  ).toBeNull();
  expect(renderUpdateRunReport(after!).markdown).not.toContain("verified serving");
});
