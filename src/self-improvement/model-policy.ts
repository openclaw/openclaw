import type {
  SelfImprovementAnalysisMode,
  SelfImprovementRecommendationGroup,
  SelfImprovementReviewModelTier,
} from "./types.js";

export const DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL = "ollama/qwen3.6:27b-q8_0";
export const DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL =
  "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest";
export const DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL = "ollama/qwen3.5:9b-q4_K_M";
export const DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL =
  "ollama/openclaw-strategic-qwen3-235b:latest";
export const OPTIONAL_SELF_IMPROVEMENT_EXTERNAL_KIMI_MODEL = "kimi-local/moonshotai/Kimi-K2.6";
export const DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL = "openai/gpt-5.5";

export type SelfImprovementReviewPolicy = "deterministic" | "hosted" | "local_first";

export type SelfImprovementModelProfile = {
  tier: SelfImprovementReviewModelTier;
  modelId: string;
  mode: SelfImprovementAnalysisMode;
  local: boolean;
  quantization?: string;
  parameters?: string;
  contextWindow?: number;
  maxOutputTokens: number;
  temperature: number;
  topP?: number;
  timeoutMs: number;
  backend?: string;
  fallbackBackend?: string;
  escalationReason?: string;
};

export type SelfImprovementReviewModelPlan = {
  policy: SelfImprovementReviewPolicy;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  hostedModelId?: string;
  attempts: SelfImprovementModelProfile[];
  escalationReason?: string;
};

export function normalizeSelfImprovementModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isStrategicSelfImprovementGroup(
  group: Pick<SelfImprovementRecommendationGroup, "category" | "criticality" | "priority">,
): boolean {
  return (
    group.category === "major_change" ||
    group.criticality === "critical" ||
    group.priority === "critical"
  );
}

export function getSelfImprovementModelProfile(params: {
  tier: SelfImprovementReviewModelTier;
  modelId: string;
  mode: SelfImprovementAnalysisMode;
  escalationReason?: string;
}): SelfImprovementModelProfile {
  const modelId = params.modelId;
  const base = {
    tier: params.tier,
    modelId,
    mode: params.mode,
    escalationReason: params.escalationReason,
  };
  if (modelId === DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL) {
    return {
      ...base,
      local: true,
      quantization: "Q8_0",
      parameters: "27B",
      contextWindow: 65_536,
      maxOutputTokens: 8_192,
      temperature: 0.2,
      topP: 0.95,
      timeoutMs: 180_000,
    };
  }
  if (modelId === "lmstudio/qwen/qwen3.6-27b") {
    return {
      ...base,
      local: true,
      quantization: "operator-selected",
      parameters: "27B",
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
      temperature: 0.2,
      topP: 0.95,
      timeoutMs: 180_000,
    };
  }
  if (
    modelId === DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL ||
    modelId === "ollama/openclaw-control-qwen3-30b-q6-chatfix"
  ) {
    return {
      ...base,
      local: true,
      quantization: modelId.startsWith("ollama/") ? "Q6" : "operator-selected",
      parameters: "30B",
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
      temperature: 0.2,
      topP: 0.95,
      timeoutMs: 180_000,
    };
  }
  if (modelId === DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL) {
    return {
      ...base,
      local: true,
      quantization: "Q4_K_M",
      parameters: "9B",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0.1,
      topP: 0.95,
      timeoutMs: 60_000,
    };
  }
  if (modelId === DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL) {
    return {
      ...base,
      local: true,
      quantization: "Ollama local",
      parameters: "235B",
      contextWindow: 262_144,
      maxOutputTokens: 16_384,
      temperature: 0.4,
      topP: 0.95,
      timeoutMs: 600_000,
    };
  }
  if (modelId === OPTIONAL_SELF_IMPROVEMENT_EXTERNAL_KIMI_MODEL) {
    return {
      ...base,
      local: true,
      backend: "vLLM",
      fallbackBackend: "SGLang",
      quantization: "native INT4",
      parameters: "1T total / 32B active",
      contextWindow: 262_144,
      maxOutputTokens: 16_384,
      temperature: 1,
      topP: 0.95,
      timeoutMs: 300_000,
    };
  }
  return {
    ...base,
    local: !modelId.startsWith("openai/") && !modelId.startsWith("codex/"),
    maxOutputTokens: params.tier === "hostedEscalation" ? 1_200 : 8_192,
    temperature: params.tier === "hostedEscalation" ? 0.1 : 0.6,
    topP: params.tier === "hostedEscalation" ? undefined : 0.95,
    timeoutMs: params.tier === "hostedEscalation" ? 90_000 : 180_000,
  };
}

export function selectSelfImprovementReviewModelPlan(params: {
  requested: boolean;
  approved?: boolean;
  localFirst?: boolean;
  modelId?: string;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  groups: readonly Pick<
    SelfImprovementRecommendationGroup,
    "category" | "criticality" | "priority"
  >[];
}): SelfImprovementReviewModelPlan {
  const requestedLocalReviewModelId = normalizeSelfImprovementModelId(params.reviewModelId);
  const requestedHostedModelId = normalizeSelfImprovementModelId(params.modelId);
  const fallbackModelId =
    normalizeSelfImprovementModelId(params.fallbackModelId) ??
    DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL;
  const strategicModelId =
    normalizeSelfImprovementModelId(params.strategicModelId) ??
    DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL;
  const hasStrategicGroup = params.groups.some((group) => isStrategicSelfImprovementGroup(group));
  if (params.localFirst) {
    const primaryModelId =
      requestedLocalReviewModelId ?? DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL;
    const hostedModelId = requestedHostedModelId ?? DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL;
    const escalationReason = hasStrategicGroup
      ? "major-change or critical self-improvement group"
      : undefined;
    const attempts: SelfImprovementModelProfile[] = [];
    attempts.push(
      getSelfImprovementModelProfile({
        tier: "primaryReview",
        modelId: primaryModelId,
        mode: "local_llm",
      }),
    );
    attempts.push(
      getSelfImprovementModelProfile({
        tier: "crossCheck",
        modelId: fallbackModelId,
        mode: "local_retry",
        escalationReason: "retry after invalid or failed primary local review",
      }),
    );
    if (hasStrategicGroup && params.allowStrategicLocal) {
      attempts.push(
        getSelfImprovementModelProfile({
          tier: "strategic",
          modelId: strategicModelId,
          mode: "strategic_local",
          escalationReason,
        }),
      );
    }
    if (params.allowHostedEscalation) {
      attempts.push(
        getSelfImprovementModelProfile({
          tier: "hostedEscalation",
          modelId: hostedModelId,
          mode: "hosted_escalation",
          escalationReason: "explicitly approved hosted escalation after local review attempts",
        }),
      );
    }
    return {
      policy: "local_first",
      reviewModelId: primaryModelId,
      fallbackModelId,
      strategicModelId,
      hostedModelId,
      attempts,
      escalationReason,
    };
  }
  if (!params.requested) {
    return { policy: "deterministic", attempts: [] };
  }
  const hostedModelId =
    requestedHostedModelId ?? requestedLocalReviewModelId ?? DEFAULT_SELF_IMPROVEMENT_HOSTED_MODEL;
  return {
    policy: "hosted",
    hostedModelId,
    attempts: [
      getSelfImprovementModelProfile({
        tier: "hostedEscalation",
        modelId: hostedModelId,
        mode: params.approved ? "hosted_escalation" : "llm",
        escalationReason: "legacy hosted LLM review request",
      }),
    ],
  };
}
