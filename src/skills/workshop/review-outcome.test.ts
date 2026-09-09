import { describe, expect, it } from "vitest";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";

describe("Skill Workshop review outcome", () => {
  it("treats run-level terminal metadata as a review failure", () => {
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          error: { kind: "retry_limit", message: "model retries exhausted" },
        },
      }),
    ).toThrow("model retries exhausted");
    expect(() =>
      assertSkillReviewRunSucceeded({ meta: { durationMs: 1 }, payloads: [{ text: "done" }] }),
    ).not.toThrow();
  });
});
