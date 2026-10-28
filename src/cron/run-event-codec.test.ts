import { describe, expect, it } from "vitest";
import { cronRunLogEntryFromEvent } from "./run-event-codec.js";

describe("cronRunLogEntryFromEvent", () => {
  it("keeps permanent script failures out of run-history timeout classification", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "script-job",
        action: "finished",
        status: "error",
        error: "cron script failed after a tool side effect: request timed out",
        provider: "anthropic",
      },
      1,
      undefined,
    );

    expect(entry.errorReason).toBeUndefined();
  });

  it("preserves explicit script timeout classification in run history", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "script-job",
        action: "finished",
        status: "error",
        completionStatus: "failed",
        error: "cron script failed",
      },
      1,
      "timeout",
    );

    expect(entry).toMatchObject({ errorReason: "timeout", completionStatus: "failed" });
  });
});
