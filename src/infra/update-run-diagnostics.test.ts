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

it("records serving health without replacing a persisted restart refusal", () => {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("update-unsafe-observation-") } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" } as const;
  recordUpdateRunVerification(run.runId, { recovery }, options);
  const verification = {
    serviceRunning: true,
    runningVersion: "2026.9.5",
    versionMatch: true,
    readyz: true,
    settled: true,
  };
  const recorded = recordUpdateRunDiagnostics(
    run.runId,
    {
      recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
      verification,
      steps: [
        {
          name: "gateway recovery verification",
          command: "verify",
          cwd: "",
          durationMs: 0,
          exitCode: 0,
        },
      ],
    },
    () => {
      throw new Error("observation was not recorded");
    },
    options,
  );
  expect(recorded?.verification).toEqual({ ...verification, recovery });
  expect(renderUpdateRunReport(recorded!).markdown).toContain(
    "Recovery: verified serving 2026.9.5; restart remains unsafe (runtime-verification-failed)",
  );
});

it.each([false, true])(
  "keeps the first terminal receipt when a stale publisher carries verification=%s",
  (observed) => {
    const options = { env: { OPENCLAW_STATE_DIR: dirs.make("update-terminal-diagnostics-") } };
    const run = createUpdateRun({ trigger: "cli" }, options);
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
          ...(observed
            ? { verification: { readyz: true, settled: true, versionMatch: true } }
            : {}),
        },
      },
      options,
    );
    expect(stale).toEqual(terminal);
    expect(getUpdateRun(run.runId, options)).toEqual(terminal);
  },
);

it("keeps recovery observations atomic across a busy write without revising the failed outcome", () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-observation-atomic-") };
  const options = { env, busyTimeoutMs: 0 };
  const run = createUpdateRun({ trigger: "cli" }, options);
  recordUpdateRunVerification(
    run.runId,
    {
      booted: true,
      noticeDelivered: true,
      doctorHint: "run doctor",
      serviceRunning: true,
      channelsReady: true,
      pluginErrors: [],
      runningVersion: "2026.9.5",
      versionMatch: true,
      readyz: true,
      settled: true,
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
            name: "gateway recovery verification",
            command: "gateway verification",
            cwd: "",
            durationMs: 0,
            exitCode: null,
            advisory: { kind: "recoverable-maintenance", message: "Gateway readiness is pending" },
          },
        ],
      }),
      warn,
      options,
    );
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
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
