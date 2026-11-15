// Covers conservative default exec auto-review decisions.
import { describe, expect, it } from "vitest";
import {
  buildExecAutoReviewFailureDecision,
  defaultExecAutoReviewer,
  normalizeExecAutoReviewRationale,
  resolveExecAutoReviewDecision,
  type ExecAutoReviewInput,
  type ExecAutoReviewer,
} from "./exec-auto-review.js";

const reviewInput = {
  command: "git status",
  argv: ["git", "status"],
  host: "gateway",
  reason: "approval-required",
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
} satisfies ExecAutoReviewInput;

describe("default exec auto reviewer", () => {
  it("falls back to human approval instead of maintaining a static allowlist", () => {
    expect(
      defaultExecAutoReviewer({ ...reviewInput, command: "pwd", argv: ["pwd"] }),
    ).toMatchObject({
      decision: "ask",
    });
  });
});

describe("exec auto-review failure handling", () => {
  it.each([
    {
      name: "Unicode line separators",
      value: "first\u2028second\u2029third",
      expected: "firstsecondthird",
    },
    { name: "missing provider explanations", value: undefined, expected: "review failed" },
  ])("normalizes $name before human approval", ({ value, expected }) => {
    expect(normalizeExecAutoReviewRationale(value, "review failed")).toBe(expected);
  });

  it("bounds the complete failure rationale without splitting surrogate pairs", () => {
    const decision = buildExecAutoReviewFailureDecision(
      "exec reviewer failed",
      "x".repeat(477) + "🚀tail",
    );

    expect(decision).toMatchObject({ decision: "ask", risk: "unknown" });
    expect(decision.rationale.length).toBeLessThanOrEqual(500);
    expect(decision.rationale).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("defers when a reviewer rejects asynchronously", async () => {
    const reviewer = async () => {
      throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
    };
    await expect(resolveExecAutoReviewDecision(reviewer, reviewInput)).resolves.toEqual({
      decision: "ask",
      risk: "unknown",
      rationale: "exec reviewer failed: provider\\nfailed",
    });
  });

  it("preserves a successful reviewer's denial", async () => {
    const decision = {
      decision: "deny",
      risk: "high",
      rationale: "reviewer explanation",
    } as const;
    const reviewer: ExecAutoReviewer = () => decision;

    await expect(resolveExecAutoReviewDecision(reviewer, reviewInput)).resolves.toBe(decision);
  });

  it("redacts provider credentials before displaying a reviewer failure", async () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const reviewer: ExecAutoReviewer = () => {
      throw new Error(`Authorization: Bearer ${secret}`);
    };

    const decision = await resolveExecAutoReviewDecision(reviewer, reviewInput);

    expect(decision).toMatchObject({ decision: "ask", risk: "unknown" });
    expect(decision.rationale).not.toContain(secret);
  });
});
