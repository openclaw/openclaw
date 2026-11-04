// Regression: a persisted stream row with malformed batching values must be
// quarantined by the shape validator. Otherwise cronStreamScheduleKey ->
// resolveCronStreamBatching throws during the single-pass stream reconcile and
// blocks every otherwise-valid stream source from starting.
import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function streamCandidate(schedule: Record<string, unknown>) {
  return {
    id: "job-1",
    schedule: { kind: "stream", command: ["watch-source"], ...schedule },
    payload: { kind: "systemEvent", text: "batch" },
    sessionTarget: "main",
  };
}

describe("getInvalidPersistedCronJobReason stream", () => {
  it.each([{}, { batchMs: 250, maxBatchBytes: 16_384 }, { mode: "match", match: "^ready\\ " }])(
    "accepts a well-formed stream schedule %j",
    (schedule) => {
      expect(getInvalidPersistedCronJobReason(streamCandidate(schedule))).toBeNull();
    },
  );

  it.each([{ batchMs: 1.5 }, { batchMs: "250" }, { maxBatchBytes: Number.NaN }])(
    "quarantines invalid batching fields %j",
    (schedule) => {
      expect(getInvalidPersistedCronJobReason(streamCandidate(schedule))).toBe("invalid-schedule");
    },
  );

  it.each(["", "  ", "^(a+)+$ "])("quarantines unusable match-mode regex %j", (match) => {
    expect(getInvalidPersistedCronJobReason(streamCandidate({ mode: "match", match }))).toBe(
      "invalid-schedule",
    );
  });
});
