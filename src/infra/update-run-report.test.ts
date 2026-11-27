import { expect, it } from "vitest";
import { expectText } from "../test-utils/text-assertions.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";

function run(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 301,
    confirmedAtMs: null,
    finishedAtMs: 301,
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

function failed(patch: Partial<UpdateRunRecord> = {}) {
  return run({ status: "failed", ...patch });
}

function failureReport(record: UpdateRunRecord) {
  return prepareUpdateFailureReport(record, { stateDir: "/fixture/state", env: {} });
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
  verification: UpdateRunRecord["verification"],
  patch: Partial<UpdateRunRecord> = {},
) {
  return failed({ steps: [recoveryStep], verification, ...patch });
}

it("preserves recorded restart constraints alongside serving observations", async () => {
  const record = observedFailure(serving("2026.9.5", "runtime-verification-failed"), {
    reason: "post-update-plugins",
  });
  const report = await failureReport(record);
  expectText(
    report.body,
    [
      "Recovery outcome: restart unverified; runtime-verification-failed",
      "Recorded running version: 2026.9.5",
    ],
    ["Recovery version:"],
  );
});

it.each([
  ["private-customer-build", false],
  ["2026.9.4-private-customer", true],
] as const)("redacts %s (observed=%s)", async (version, observed) => {
  const record = failed({
    ...(observed ? { steps: [recoveryStep] } : {}),
    verification: observed
      ? { port: 19123, ...verified(version), recovery: healthy(version) }
      : { port: 19123, versionMatch: false },
  });
  const report = await failureReport(record);
  expect(report.body).toContain(`Recorded versionMatch: ${observed}`);
  if (observed) {
    expectText(
      report.body,
      ["Recovery version: [redacted-version]", "Recorded running version: [redacted-version]"],
      [version],
    );
  }
  expect(report.body).not.toContain("Current health:");
});

it("does not report a missing running identity as a version mismatch", async () => {
  const record = failed({
    reason: "restart-unhealthy",
    after: { version: "2026.9.2", buildId: "candidate-build" },
    verification: { serviceRunning: true, versionMatch: false },
  });
  const failure = await failureReport(record);
  expectText(failure.body, ["Recorded versionMatch: false"], ["version mismatch"]);
});

it("reports legacy expiry in manual failure reports", async () => {
  const record = failed({ reason: "legacy-driver-expired" });
  const text = (await failureReport(record)).body;
  expect(text).toContain(
    "A 2026.9.2-era update never progressed past admission; treated as abandoned after 24 h; run `openclaw update` to retry.",
  );
});
