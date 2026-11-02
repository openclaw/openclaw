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
