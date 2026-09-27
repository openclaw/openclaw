import { describe, expect, it } from "vitest";
import {
  assertSkillReviewRunSucceeded,
  SkillReviewOversizedContextError,
  SkillReviewOversizedRequestError,
} from "./review-outcome.js";

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

  it("raises the typed oversized error only for the review preflight overflow", () => {
    try {
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message:
              "Skill experience review prompt exceeds effective budget: estimatedPromptTokens=90000 promptBudgetBeforeReserve=32000",
          },
        },
      });
      throw new Error("expected oversized review error");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillReviewOversizedRequestError);
      expect(error).toMatchObject({
        estimatedPromptTokens: 90_000,
        promptBudgetBeforeReserve: 32_000,
      });
    }
  });

  it("routes a provider-level context overflow through the bounded-context skip type", () => {
    try {
      assertSkillReviewRunSucceeded({
        meta: {
          durationMs: 1,
          error: { kind: "context_overflow", message: "provider rejected oversized prompt" },
        },
      });
      throw new Error("expected bounded-context review error");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillReviewOversizedContextError);
      expect(error).not.toBeInstanceOf(SkillReviewOversizedRequestError);
      expect((error as SkillReviewOversizedContextError).limitReason).toBe(
        "provider rejected oversized prompt",
      );
    }
  });

  it("carries bounded-context extraction overflows with a distinct type", () => {
    const error = new SkillReviewOversizedContextError(
      "Required session context boundary exceeds the model-context limit",
    );
    expect(error).toBeInstanceOf(SkillReviewOversizedContextError);
    expect(error.name).toBe("SkillReviewOversizedContextError");
    expect(error.limitReason).toBe(
      "Required session context boundary exceeds the model-context limit",
    );
    expect(error.message).toContain("exceeds the configured review limit");
  });
});
