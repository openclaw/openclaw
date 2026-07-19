import { describe, expect, it } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { buildLateUpdateFailureResult } from "./update-command-post-update.js";

describe("late update failure result", () => {
  it("turns a deferred successful result into a machine-readable rollback failure", () => {
    const result: UpdateRunResult = {
      status: "ok",
      mode: "npm",
      root: "/managed/openclaw",
      before: { version: "1.0.0" },
      after: { version: "2.0.0" },
      steps: [],
      durationMs: 42,
    };

    expect(buildLateUpdateFailureResult(result, "delivery confirmation timed out")).toEqual({
      ...result,
      status: "error",
      reason: "delivery confirmation timed out",
    });
  });
});
