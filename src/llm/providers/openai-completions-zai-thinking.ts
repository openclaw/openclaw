import type { ModelThinkingLevel } from "../types.js";

type ZaiCompletionsThinkingModel = {
  id: string;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
};
type ZaiCompletionsRequestedEffort = ModelThinkingLevel | "none";

function isZaiOpenAICompletionsReasoningEffortSupported(
  model: ZaiCompletionsThinkingModel,
): boolean {
  return model.id.toLowerCase().startsWith("glm-5.2") || model.thinkingLevelMap !== undefined;
}

export function resolveZaiOpenAICompletionsThinkingParams(params: {
  model: ZaiCompletionsThinkingModel;
  requestedEffort: ZaiCompletionsRequestedEffort | undefined;
}): { thinking: { type: "enabled" | "disabled" }; reasoningEffort?: string } {
  const effort = params.requestedEffort;
  if (!effort || effort === "off" || effort === "none" || effort === "minimal") {
    return { thinking: { type: "disabled" } };
  }
  const mapped = params.model.thinkingLevelMap?.[effort];
  const reasoningEffort = mapped ?? (effort === "xhigh" || effort === "max" ? "max" : "high");
  return {
    thinking: { type: "enabled" },
    ...(isZaiOpenAICompletionsReasoningEffortSupported(params.model) ? { reasoningEffort } : {}),
  };
}
