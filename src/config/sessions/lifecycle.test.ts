import { describe, expect, it } from "vitest";
import { isRestartContinuationAllowed } from "./lifecycle.js";

describe("isRestartContinuationAllowed", () => {
  const satisfied = {
    restartContinuation: true,
    abortedLastRun: true,
    reusableFresh: true,
    terminalMainTranscriptNewerThanRegistry: true,
  };

  it("allows continuation when every gate is satisfied", () => {
    expect(isRestartContinuationAllowed(satisfied)).toBe(true);
  });

  it("requires the opt-in, so it stays off by default", () => {
    expect(isRestartContinuationAllowed({ ...satisfied, restartContinuation: false })).toBe(false);
    expect(isRestartContinuationAllowed({ ...satisfied, restartContinuation: undefined })).toBe(
      false,
    );
  });

  it("requires the previous run to have aborted", () => {
    expect(isRestartContinuationAllowed({ ...satisfied, abortedLastRun: false })).toBe(false);
    expect(isRestartContinuationAllowed({ ...satisfied, abortedLastRun: undefined })).toBe(false);
  });

  it("requires a reusable fresh entry", () => {
    expect(isRestartContinuationAllowed({ ...satisfied, reusableFresh: false })).toBe(false);
  });

  it("only applies when the terminal transcript is newer than the registry", () => {
    expect(
      isRestartContinuationAllowed({
        ...satisfied,
        terminalMainTranscriptNewerThanRegistry: false,
      }),
    ).toBe(false);
  });
});
