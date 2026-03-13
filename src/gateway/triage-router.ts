export type TriageLane = "api_only" | "low_llm" | "high_llm";

export type TriagePolicyDecision = "allow" | "deny" | "ask_clarification" | "stepup";

export type TriageSelectionReason =
  | "highest_score"
  | "low_confidence_structured_fallback"
  | "low_confidence_light_llm_fallback"
  | "low_confidence_heavy_llm_fallback";

export type TriageRequestContext = {
  intentSlug: string;
  actionType: "read" | "write" | "notify";
  executionHint: "api-first" | "api+light-llm" | "heavy-llm";
  isFinancial: boolean;
  isEmergency?: boolean;
  hasRequiredEntities: boolean;
  identityConfidence: number;
  intentConfidence: number;
  entityConfidence: number;
  estimatedLatencyMs: {
    apiOnly: number;
    lowLlm: number;
    highLlm: number;
  };
  dataAvailability: {
    apiOnly: number;
    lowLlm: number;
    highLlm: number;
  };
};

export type TriageLaneScore = {
  lane: TriageLane;
  score: number;
  features: {
    confidence: number;
    policyFit: number;
    latencyFit: number;
    dataAvailability: number;
    penalty: number;
  };
};

export type TriageSelection = {
  selectedLane: TriageLane;
  reason: TriageSelectionReason;
  scores: TriageLaneScore[];
};

const SCORE_THRESHOLD = 0.6;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function resolveLatencyFit(estimatedLatencyMs: number, budgetMs: number): number {
  if (budgetMs <= 0) {
    return 0;
  }
  const ratio = estimatedLatencyMs / budgetMs;
  if (ratio <= 0.5) {
    return 1;
  }
  if (ratio >= 2) {
    return 0;
  }
  return clamp01(1 - (ratio - 0.5) / 1.5);
}

function confidenceForLane(ctx: TriageRequestContext, lane: TriageLane): number {
  const identity = clamp01(ctx.identityConfidence);
  const intent = clamp01(ctx.intentConfidence);
  const entity = clamp01(ctx.entityConfidence);
  const base = identity * 0.35 + intent * 0.45 + entity * 0.2;
  if (lane === "api_only") {
    return clamp01(base + (ctx.hasRequiredEntities ? 0.15 : -0.2));
  }
  if (lane === "low_llm") {
    return clamp01(base + 0.05);
  }
  return clamp01(base);
}

function policyFitForLane(ctx: TriageRequestContext, lane: TriageLane): number {
  if (ctx.isEmergency && lane === "high_llm") {
    return 0.8;
  }
  if (ctx.isFinancial && lane === "high_llm") {
    return 0.7;
  }
  if (ctx.actionType === "write" && lane === "api_only") {
    return 0.75;
  }
  return 1;
}

function penaltyForLane(ctx: TriageRequestContext, lane: TriageLane): number {
  let penalty = 0;
  if (!ctx.hasRequiredEntities && lane === "api_only") {
    penalty += 0.25;
  }
  if (ctx.isFinancial && lane === "high_llm") {
    penalty += 0.1;
  }
  if (ctx.executionHint === "api-first" && lane === "high_llm") {
    penalty += 0.15;
  }
  if (ctx.executionHint === "heavy-llm" && lane === "api_only") {
    penalty += 0.08;
  }
  return penalty;
}

function scoreLane(params: {
  lane: TriageLane;
  ctx: TriageRequestContext;
  latencyBudgetMs: number;
}): TriageLaneScore {
  const { lane, ctx, latencyBudgetMs } = params;
  const confidence = confidenceForLane(ctx, lane);
  const policyFit = policyFitForLane(ctx, lane);
  const latencyFit =
    lane === "api_only"
      ? resolveLatencyFit(ctx.estimatedLatencyMs.apiOnly, latencyBudgetMs)
      : lane === "low_llm"
        ? resolveLatencyFit(ctx.estimatedLatencyMs.lowLlm, latencyBudgetMs)
        : resolveLatencyFit(ctx.estimatedLatencyMs.highLlm, latencyBudgetMs);
  const dataAvailability =
    lane === "api_only"
      ? clamp01(ctx.dataAvailability.apiOnly)
      : lane === "low_llm"
        ? clamp01(ctx.dataAvailability.lowLlm)
        : clamp01(ctx.dataAvailability.highLlm);

  const penalty = penaltyForLane(ctx, lane);
  const rawScore =
    confidence * 0.35 + policyFit * 0.25 + latencyFit * 0.2 + dataAvailability * 0.2 - penalty;

  return {
    lane,
    score: clamp01(rawScore),
    features: {
      confidence,
      policyFit,
      latencyFit,
      dataAvailability,
      penalty,
    },
  };
}

export function scoreTriageLanes(ctx: TriageRequestContext, latencyBudgetMs: number): TriageLaneScore[] {
  const scores = [
    scoreLane({ lane: "api_only", ctx, latencyBudgetMs }),
    scoreLane({ lane: "low_llm", ctx, latencyBudgetMs }),
    scoreLane({ lane: "high_llm", ctx, latencyBudgetMs }),
  ];
  return [...scores].toSorted((left, right) => right.score - left.score);
}

export function selectLaneFromScores(params: {
  policyDecision: TriagePolicyDecision;
  request: TriageRequestContext;
  latencyBudgetMs: number;
}): TriageSelection {
  const { policyDecision, request, latencyBudgetMs } = params;
  const scores = scoreTriageLanes(request, latencyBudgetMs);

  if (policyDecision !== "allow") {
    return {
      selectedLane: "api_only",
      reason: "highest_score",
      scores,
    };
  }

  const top = scores[0];
  if (top.score >= SCORE_THRESHOLD) {
    return {
      selectedLane: top.lane,
      reason: "highest_score",
      scores,
    };
  }

  if (request.hasRequiredEntities && request.executionHint !== "heavy-llm") {
    return {
      selectedLane: "api_only",
      reason: "low_confidence_structured_fallback",
      scores,
    };
  }

  if (request.executionHint === "heavy-llm") {
    return {
      selectedLane: "high_llm",
      reason: "low_confidence_heavy_llm_fallback",
      scores,
    };
  }

  return {
    selectedLane: "low_llm",
    reason: "low_confidence_light_llm_fallback",
    scores,
  };
}