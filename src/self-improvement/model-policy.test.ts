import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
  DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL,
  DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
  DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL,
  DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL,
  selectSelfImprovementReviewModelPlan,
} from "./model-policy.js";

describe("self-improvement model policy", () => {
  it("keeps local-first --model reserved for hosted escalation instead of primary review", () => {
    const plan = selectSelfImprovementReviewModelPlan({
      requested: false,
      localFirst: true,
      modelId: "openai/gpt-5.5",
      groups: [],
    });

    expect(plan).toMatchObject({
      policy: "local_first",
      reviewModelId: DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
      fallbackModelId: DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
      strategicModelId: DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL,
      hostedModelId: "openai/gpt-5.5",
    });
    expect(plan.attempts.map((attempt) => attempt.modelId)).toEqual([
      DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
      DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
    ]);
  });

  it("adds the requested hosted model only when local-first hosted escalation is allowed", () => {
    const plan = selectSelfImprovementReviewModelPlan({
      requested: false,
      localFirst: true,
      modelId: "openai/gpt-5.5",
      reviewModelId: "ollama/custom-primary",
      allowHostedEscalation: true,
      groups: [],
    });

    expect(plan).toMatchObject({
      reviewModelId: "ollama/custom-primary",
      hostedModelId: "openai/gpt-5.5",
    });
    expect(plan.attempts.map((attempt) => `${attempt.tier}:${attempt.modelId}`)).toEqual([
      "primaryReview:ollama/custom-primary",
      `crossCheck:${DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL}`,
      "hostedEscalation:openai/gpt-5.5",
    ]);
  });

  it("defaults hosted review policy to the hosted model when no model override is supplied", () => {
    const plan = selectSelfImprovementReviewModelPlan({
      requested: true,
      localFirst: false,
      groups: [],
    });

    expect(plan).toMatchObject({
      policy: "hosted",
      hostedModelId: DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL,
    });
    expect(plan.attempts).toHaveLength(1);
    expect(plan.attempts[0]?.tier).toBe("hostedEscalation");
  });

  it("uses the default hosted escalation model when local-first escalation is allowed without --model", () => {
    const plan = selectSelfImprovementReviewModelPlan({
      requested: false,
      localFirst: true,
      allowHostedEscalation: true,
      groups: [],
    });

    expect(plan.hostedModelId).toBe(DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL);
    expect(plan.attempts.at(-1)).toMatchObject({
      tier: "hostedEscalation",
      modelId: DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL,
    });
  });

  it("keeps Qwen primary, chatfix cross-check, then strategic Qwen ordering for local-first groups", () => {
    const plan = selectSelfImprovementReviewModelPlan({
      requested: false,
      localFirst: true,
      allowStrategicLocal: true,
      groups: [{ category: "major_change", criticality: "critical", priority: "critical" }],
    });

    expect(plan).toMatchObject({
      policy: "local_first",
      reviewModelId: DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
      fallbackModelId: DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
      strategicModelId: DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL,
      escalationReason: "major-change or critical self-improvement group",
    });
    expect(plan.attempts.map((attempt) => `${attempt.tier}:${attempt.modelId}`)).toEqual([
      `primaryReview:${DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL}`,
      `crossCheck:${DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL}`,
      `strategic:${DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL}`,
    ]);
  });

  it("exposes an installed local triage model profile", () => {
    expect(DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL).toBe("ollama/qwen3.5:9b-q4_K_M");
  });
});
