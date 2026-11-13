import {
  decodeOpenAIDecisionResult,
  encodeOpenAIDecisionRequest,
  supportsOpenAIDecisionBatch,
} from "../decisions/openai-codec.js";
import type { ProviderDecisionOutcomeV2 } from "../decisions/provider-outcomes.js";
import type { DecisionProviderV2 } from "../decisions/provider-types.js";
import type { DecisionBatchV2 } from "../decisions/types-v2.js";
import { evaluateDecisionHttp } from "./decisions-http-runtime.js";

export { supportsOpenAIDecisionBatch } from "../decisions/openai-codec.js";

type Context = Parameters<DecisionProviderV2["evaluate"]>[1];

/** Execute the OpenAI Decisions wire format; never fall back to conversational inference. */
export async function evaluateOpenAICompatibleDecision(
  batch: DecisionBatchV2,
  context: Context,
  route: { provider: string; baseUrl: string; modelId?: string },
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (!supportsOpenAIDecisionBatch(batch, context.reasoning)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateDecisionHttp(context, {
    provider: route.provider,
    baseUrl: route.baseUrl,
    endpointPath: "decisions",
    body: JSON.stringify(encodeOpenAIDecisionRequest(batch, route.modelId ?? context.model.id)),
    decode: (payload) => decodeOpenAIDecisionResult(batch, payload),
  });
}
