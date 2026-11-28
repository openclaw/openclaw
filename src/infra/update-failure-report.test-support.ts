import type { UpdateRunRecord } from "./update-run-record.js";

export function failedUpdateRun(fields: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: "00000000-0000-0000-0000-000000000000",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: "build-failed",
    origin: {},
    target: { kind: "git", version: "2026.8.2" },
    before: { version: "2026.8.1" },
    after: {},
    steps: [{ step: "build", status: "failed", exitCode: 1 }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
    ...fields,
  };
}
