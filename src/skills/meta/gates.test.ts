import { describe, expect, it } from "vitest";
import { summarizeMetaGateResults } from "./gates.js";

describe("summarizeMetaGateResults", () => {
  it("marks all-passed gates as passed", () => {
    expect(
      summarizeMetaGateResults([
        { name: "lint", result: "passed" },
        { name: "runtime_e2e", result: "passed" },
      ]),
    ).toEqual({ result: "passed", evidence: "lint: passed\nruntime_e2e: passed" });
  });

  it("marks any failed gate as failed", () => {
    expect(
      summarizeMetaGateResults([
        { name: "lint", result: "passed" },
        { name: "runtime_e2e", result: "failed" },
      ]).result,
    ).toBe("failed");
  });
});
