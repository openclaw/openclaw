import { createUpdateRunRecordFixture } from "../../../src/infra/update-run-record.test-support.ts";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";

export function createUpdateRunFixture(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return createUpdateRunRecordFixture("6631ecee-adbf-41e8-a0e3-1b88b28b0a59", {
    trigger: "control-ui",
    phase: "staging",
    status: "running",
    target: { kind: "package", version: "2026.9.2" },
    before: { version: "2026.9.1" },
    steps: [
      { step: "requested", status: "completed" },
      { step: "staging", status: "in_progress" },
    ],
    finishedAtMs: null,
    ...patch,
  });
}

/** Same release label, different builds: the old process answered the update's verification. */
export function createFailedVerificationRun() {
  const now = Date.now();
  return createUpdateRunFixture({
    status: "failed",
    phase: "finished",
    reason: "post-update-failed",
    createdAtMs: now - 120_000,
    updatedAtMs: now - 60_000,
    finishedAtMs: now - 60_000,
    target: { kind: "git", channel: "dev", sha: "b".repeat(40) },
    before: { version: "1.0.0", buildId: "before-build", sha: "a".repeat(40) },
    after: { version: "1.0.0", buildId: "target-build", sha: "b".repeat(40) },
    steps: [{ step: "verifying", status: "failed" }],
    verification: {
      serviceRunning: true,
      runningVersion: "1.0.0",
      runningBuildId: "before-build",
      versionMatch: false,
    },
  });
}
