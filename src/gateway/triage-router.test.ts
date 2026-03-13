import { describe, expect, it } from "vitest";
import {
  scoreTriageLanes,
  selectLaneFromScores,
  type TriageRequestContext,
} from "./triage-router.js";

function buildBaseContext(): TriageRequestContext {
  return {
    intentSlug: "current_balance",
    actionType: "read",
    executionHint: "api-first",
    isFinancial: true,
    isEmergency: false,
    hasRequiredEntities: true,
    identityConfidence: 0.92,
    intentConfidence: 0.95,
    entityConfidence: 0.93,
    estimatedLatencyMs: {
      apiOnly: 350,
      lowLlm: 1200,
      highLlm: 2400,
    },
    dataAvailability: {
      apiOnly: 0.95,
      lowLlm: 0.8,
      highLlm: 0.75,
    },
  };
}

describe("triage-router", () => {
  it("prioritizes api_only for structured api-first requests", () => {
    const scores = scoreTriageLanes(buildBaseContext(), 2500);
    expect(scores[0]?.lane).toBe("api_only");
    expect(scores[0]?.score).toBeGreaterThan(0.6);
  });

  it("falls back to low_llm when confidence is low and entities are missing", () => {
    const context: TriageRequestContext = {
      ...buildBaseContext(),
      hasRequiredEntities: false,
      identityConfidence: 0.3,
      intentConfidence: 0.4,
      entityConfidence: 0.2,
      executionHint: "api+light-llm",
      dataAvailability: {
        apiOnly: 0.2,
        lowLlm: 0.7,
        highLlm: 0.7,
      },
    };

    const selection = selectLaneFromScores({
      policyDecision: "allow",
      request: context,
      latencyBudgetMs: 2500,
    });

    expect(selection.selectedLane).toBe("low_llm");
    expect(selection.reason).toBe("highest_score");
  });

  it("uses heavy-llm fallback for heavy execution hints when scores are below threshold", () => {
    const context: TriageRequestContext = {
      ...buildBaseContext(),
      hasRequiredEntities: false,
      identityConfidence: 0.2,
      intentConfidence: 0.3,
      entityConfidence: 0.25,
      executionHint: "heavy-llm",
      dataAvailability: {
        apiOnly: 0.1,
        lowLlm: 0.2,
        highLlm: 0.4,
      },
    };

    const selection = selectLaneFromScores({
      policyDecision: "allow",
      request: context,
      latencyBudgetMs: 2000,
    });

    expect(selection.selectedLane).toBe("high_llm");
    expect(selection.reason).toBe("low_confidence_heavy_llm_fallback");
  });
});
