import { describe, expect, it } from "vitest";
import { assertSkillReviewRunSucceeded } from "./review-outcome.js";

describe("Skill Workshop review outcome", () => {
  it("preserves actionable error payloads over the unresolved tool summary", () => {
    expect(() =>
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          toolSummary: {
            calls: 1,
            tools: ["skill_workshop"],
            failures: 1,
            unresolvedError: { toolName: "skill_workshop" },
          },
        },
        payloads: [{ isError: true, text: "Proposal rejected: read the current skill and retry." }],
      }),
    ).toThrow("Proposal rejected: read the current skill and retry.");
  });

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
