import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { updateRunFixture } from "./update-run-fixture.test-support.js";
import { renderUpdateRunReport } from "./update-run-report.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
function fixture(busyTimeoutMs?: number, trigger: "cli" | "api" = "cli") {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("update-diagnostics-") }, busyTimeoutMs };
  return updateRunFixture(options, { trigger });
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

it.each(["failed", "succeeded", "skipped", "rolled-back"] as const)(
  "enriches only failed terminal diagnostics without replacing the %s outcome",
  (status) => {
    const { step, finish, record } = fixture(undefined, "api");
    const original = { check: "managed-service", code: "EACCES", message: "Permission denied" };
    const late = { check: "managed-service", code: "handoff-permission-denied" };
    step({
      step: "requested",
      status: "failed",
      detail: "original refusal",
      exitCode: 7,
      failureFacts: [original],
    });
    const terminal = finish({ status, reason: "original-outcome" });
    const append = () =>
      record({
        failure: {
          step: "requested",
          detail: "late refusal",
          exitCode: 9,
          failureFacts: [original, late],
        },
      });
    const recorded = append();
    expect(append()).toEqual(recorded);
    expect(recorded).toMatchObject({
      status,
      reason: "original-outcome",
      finishedAtMs: terminal.finishedAtMs,
      steps: [
        {
          ...terminal.steps[0],
          failureFacts: status === "failed" ? [original, late] : [original],
        },
      ],
    });
  },
);

it("records serving health without replacing a persisted restart refusal", () => {
  const { verify, record } = fixture();
  verify({ recovery });
  const recorded = record({
    recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
    verification: healthy,
    steps: [observation(0)],
  });
  expect(recorded?.verification).toEqual({ ...healthy, recovery });
  expect(renderUpdateRunReport(recorded!).markdown).toContain(
    "Recorded recovery: verified serving 2026.9.5; restart remains unsafe (runtime-verification-failed)",
  );
});

it.each([undefined, "active-mutation"] as const)(
  "preserves named data risk over an older refusal (%s) and healthy observation",
  (existingRisk) => {
    const { verify, record, read } = fixture();
    verify({
      recovery: {
        ...recovery,
        ...(existingRisk ? { dataAtRisk: existingRisk } : {}),
      },
    });
    const incoming = {
      ...recovery,
      dataAtRisk: "unreadable-state",
    } as const;
    record({ recovery: incoming, verification: { serviceRunning: true, readyz: true } }, () => {});
    expect(read()?.verification.recovery).toEqual({
      ...incoming,
      dataAtRisk: existingRisk ?? incoming.dataAtRisk,
    });
  },
);

it("keeps the first terminal receipt when a stale publisher carries success verification", () => {
  const { finish, read } = fixture();
  const terminal = finish({
    status: "failed",
    reason: "doctor-failed",
    diagnostics: {
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
  });
  const stale = finish({
    status: "succeeded",
    diagnostics: {
      recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
      verification: { readyz: true, settled: true, versionMatch: true },
    },
  });
  expect(stale).toEqual(terminal);
  expect(read()).toEqual(terminal);
});

it("keeps recovery observations atomic across a busy write without revising the failed outcome", () => {
  const { options, verify, step, finish, read, record } = fixture(0);
  verify({
    booted: true,
    noticeDelivered: true,
    doctorHint: "run doctor",
    ...healthy,
    channelsReady: true,
    pluginErrors: [],
    recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
  });
  step({ step: "gateway recovery verification", status: "completed", exitCode: 0 });
  finish({ status: "failed", reason: "doctor-failed" });
  const before = read();
  expect(before?.confirmedAtMs).toEqual(expect.any(Number));
  const warn = vi.fn();
  const recordPending = () =>
    record(
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
    );
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  try {
    writer.exec("BEGIN IMMEDIATE");
    recordPending();
    expect(warn).toHaveBeenCalledOnce();
    expect(read()).toEqual(before);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  warn.mockClear();
  recordPending();
  expect(warn).not.toHaveBeenCalled();
  const after = read();
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
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "gateway recovery verification", exitCode: null }),
    ]),
  });
  expect(after?.verification.runningVersion).toBeUndefined();
  expect(renderUpdateRunReport(after!).markdown).not.toContain("verified serving");
});
