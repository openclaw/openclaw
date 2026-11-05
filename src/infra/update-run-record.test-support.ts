import type { UpdateRunRecord } from "./update-run-record.js";

export function createUpdateRunRecordFixture(
  runId: string,
  overrides: Partial<UpdateRunRecord>,
): UpdateRunRecord {
  return {
    runId,
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: null,
    origin: {},
    target: {},
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
    ...overrides,
  };
}
