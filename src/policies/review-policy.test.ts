import { describe, expect, it } from "vitest";
import { determineReviewRecommendation, getHighestSeverity } from "./review-policy.js";

describe("review policy", () => {
  it("maps critical and high findings to manual_review", () => {
    expect(determineReviewRecommendation([{ severity: "critical" }])).toBe("manual_review");
    expect(determineReviewRecommendation([{ severity: "high" }])).toBe("manual_review");
  });

  it("maps medium findings to warn", () => {
    expect(determineReviewRecommendation([{ severity: "medium" }])).toBe("warn");
  });

  it("maps low, info, and empty findings to allow", () => {
    expect(determineReviewRecommendation([{ severity: "low" }])).toBe("allow");
    expect(determineReviewRecommendation([{ severity: "info" }])).toBe("allow");
    expect(determineReviewRecommendation([])).toBe("allow");
  });

  it("returns the highest severity present", () => {
    expect(
      getHighestSeverity([{ severity: "medium" }, { severity: "high" }, { severity: "low" }]),
    ).toBe("high");
  });
});
