import { describe, expect, it } from "vitest";
import { CronOperatorSourceError } from "./operator-source-error.js";

describe("CronOperatorSourceError", () => {
  it("explains both re-enabling after restored access and recreating from an authenticated turn", () => {
    const err = new CronOperatorSourceError(
      new Error("Restart recovery operator source policy changed."),
    );
    expect(err.message).toContain("re-enable this job and verify its next check");
    expect(err.message).toContain("recreate it from an authenticated turn");
    expect(err.message).toContain("Restart recovery operator source policy changed.");
  });
});
