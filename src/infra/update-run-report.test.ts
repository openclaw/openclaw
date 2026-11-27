import { afterEach, expect, it, vi } from "vitest";
import { expectText } from "../test-utils/text-assertions.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import * as reportHealth from "./update-run-report-health.js";
import type { UpdateRunReportInput } from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

type ReportRecord = UpdateRunReportInput & Pick<UpdateRunRecord, "runId" | "trigger">;
function run(patch: Partial<ReportRecord> = {}): ReportRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    trigger: "cli",
    phase: "finished",
    status: "succeeded",
    reason: null,
    origin: {},
    target: { kind: "package" },
    before: { version: "2026.9.1" },
    after: { version: "2026.9.2" },
    steps: [{ step: "staging", status: "completed", startedAtMs: 1, endedAtMs: 301 }],
    verification: {},
    repair: [],
    downtimeMs: null,
    ...patch,
  };
}

function failed(patch: Partial<ReportRecord> = {}) {
  return run({ status: "failed", ...patch });
}

function failureReport(
  record: ReportRecord,
  result: Partial<UpdateRunResult> = {},
  recorded = true,
) {
  return prepareUpdateFailureReport(
    {
      attemptId: record.runId,
      ...(recorded ? { recordedRun: record } : {}),
      result: { status: "error", mode: "npm", steps: [], durationMs: 0, ...result },
    },
    { stateDir: "/fixture/state", env: {} },
  );
}

function resultStep(
  name: string,
  patch: Partial<UpdateRunResult["steps"][number]> = {},
): UpdateRunResult["steps"][number] {
  return { name, command: name, cwd: "/fixture", durationMs: 0, exitCode: 0, ...patch };
}

const recoveryStep = {
  step: "gateway recovery verification",
  status: "completed",
  exitCode: 0,
} as const;
function verified(version: string) {
  return { runningVersion: version, versionMatch: true, readyz: true, settled: true };
}
function healthy(version: string) {
  return { serviceRestartSafe: true, service: "healthy", version } as const;
}
type RecoveryReason = "state-migration-started" | "runtime-verification-failed";
function serving(version: string, reason: RecoveryReason) {
  return {
    ...verified(version),
    recovery: { serviceRestartSafe: false as const, reason },
  };
}
function observedFailure(
  verification: ReportRecord["verification"],
  patch: Partial<ReportRecord> = {},
) {
  return failed({ steps: [recoveryStep], verification, ...patch });
}

afterEach(() => vi.restoreAllMocks());

it("preserves recorded restart constraints over newer healthy recovery facts", async () => {
  const record = observedFailure(serving("2026.9.5", "runtime-verification-failed"), {
    reason: "post-update-plugins",
  });
  const report = await failureReport(record, {
    verification: verified("2026.9.5"),
    recovery: healthy("2026.9.5"),
    steps: [resultStep("gateway recovery verification", { command: "verify" })],
  });
  expect(report.body).toContain(
    "Recovery outcome: verified serving 2026.9.5; restart remains unsafe (runtime-verification-failed)",
  );
});

it.each([
  ["private-customer-build", false],
  ["2026.9.4-private-customer", true],
] as const)("redacts %s (observed=%s)", async (version, observed) => {
  vi.spyOn(reportHealth, "readUpdateRunReportHealth").mockResolvedValue({
    kind: "responding",
    version,
  });
  const record = failed({
    ...(observed ? { steps: [recoveryStep] } : {}),
    verification: observed
      ? { port: 19123, ...verified(version), recovery: healthy(version) }
      : { port: 19123, versionMatch: false },
  });
  const report = await failureReport(record);
  expect(report.body).toContain(
    `Recorded verification: ${observed ? "version verified" : "service identity unavailable"}`,
  );
  if (observed) {
    expect(report.body).toContain("Recovery outcome: verified serving [redacted-version]");
  }
  expectText(
    report.body,
    [
      "Current health: Gateway answered on the recorded port ([redacted-version]).",
      "not a current instruction to stop or restart",
    ],
    [version],
  );
});

it("does not report a missing running identity as a version mismatch", async () => {
  const record = failed({
    reason: "restart-unhealthy",
    after: { version: "2026.9.2", buildId: "candidate-build" },
    verification: { serviceRunning: true, versionMatch: false },
  });
  const failure = await failureReport(record);
  expectText(failure.body, ["identity unavailable"], ["version mismatch"]);
});

it("reports legacy expiry in manual failure reports", async () => {
  const record = failed({ reason: "legacy-driver-expired" });
  const text = (
    await failureReport(record, { mode: "unknown", reason: "legacy-driver-expired" }, false)
  ).body;
  expect(text).toContain(
    "A 2026.9.2-era update never progressed past admission; treated as abandoned after 24 h; run `openclaw update` to retry.",
  );
});
