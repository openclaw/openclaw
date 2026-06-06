import { describe, expect, it } from "vitest";
import { statusSummaryRuntime } from "./status.summary.runtime.js";

describe("statusSummaryRuntime.resolveSessionModelRef", () => {
  it("normalizes shorthand runtime model refs without an explicit provider override", () => {
    const resolved = statusSummaryRuntime.resolveSessionModelRef(
      {},
      {
        model: "anthropic/sonnet-4.6",
      },
    );

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
});
