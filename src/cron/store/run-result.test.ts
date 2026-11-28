import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { cronRunResultEvent } from "./run-result.js";
import type { CronRunFinalizationOutcome } from "./runtime-worker.types.js";

describe("finished cron run identity", () => {
  it.each([
    [undefined, "admitted-task", "admitted-task"],
    ["public-manual", "admitted-task", "public-manual"],
    [undefined, undefined, undefined],
  ])("retains public %s or admitted %s identity", (manualRunId, taskRunId, expected) => {
    const job = makeCronJob({ id: "scheduled-job" });
    const result: Omit<CronRunFinalizationOutcome, "errorReason"> = {
      jobId: job.id,
      job,
      taskRunId,
      status: "error",
      completionStatus: "failed",
      deliveryState: { status: "not-delivered", failureNotification: { status: "not-delivered" } },
      startedAt: 100,
      endedAt: 120,
      sessionId: "unrelated-session",
      ...(manualRunId
        ? { request: { runId: manualRunId, preserveCadence: false, scheduleOwnershipAtMs: 100 } }
        : {}),
    };
    const event = cronRunResultEvent(job, result);
    expect(event.runId).toBe(expected);
    expect(event.runId).not.toBe(result.sessionId);
    expect(event.status).toBe("error");
  });
});
