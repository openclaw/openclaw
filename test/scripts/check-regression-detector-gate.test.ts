import { describe, expect, it } from "vitest";
import {
  evaluateRegressionDetectorGate,
  isTradingSensitiveBugFix,
} from "../../scripts/check-regression-detector-gate.mjs";

function pr(overrides: Record<string, unknown> = {}) {
  return {
    title: "fix: repair gateway memory use",
    body: [
      "## Summary",
      "Fixes memory growth after compaction.",
      "Pre-fix reproduction command failed before this change.",
      "Post-fix verification command passed after this change.",
      "Regression test command passed and covers the guard.",
    ].join("\n"),
    labels: [],
    ...overrides,
  };
}

describe("check-regression-detector-gate", () => {
  it("does not treat normal engineering risk/order words as trading-sensitive", () => {
    const pullRequest = pr({
      body: [
        "## Summary",
        "Fix ordering of gateway shutdown handlers and reduce merge risk.",
        "Pre-fix reproduction command failed before this change.",
        "Post-fix verification command passed after this change.",
        "Regression test command passed and covers the guard.",
      ].join("\n"),
    });

    expect(isTradingSensitiveBugFix(pullRequest)).toBe(false);
    expect(evaluateRegressionDetectorGate(pullRequest).missing).toEqual([]);
  });

  it("requires risk-officer approval for trading-sensitive bug fixes", () => {
    const evaluation = evaluateRegressionDetectorGate(
      pr({
        body: [
          "## Summary",
          "Fix trading scanner entry restart behavior.",
          "Pre-fix reproduction command failed before this change.",
          "Post-fix verification command passed after this change.",
          "Regression test command passed and covers the guard.",
        ].join("\n"),
      }),
    );

    expect(evaluation.missing).toContain(
      "risk-officer-approved label for trading-sensitive bug-fix PR",
    );
  });
});
