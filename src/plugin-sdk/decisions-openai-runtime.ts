import { getModelProviderRequestTransport } from "../agents/provider-request-config.js";
import {
  decodeOpenAIDecisionResult,
  encodeOpenAIDecisionRequest,
  supportsOpenAIDecisionBatch,
} from "../decisions/openai-codec.js";
import type { ProviderDecisionOutcomeV2 } from "../decisions/provider-outcomes.js";
import type { DecisionProviderV2 } from "../decisions/provider-types.js";
import type { DecisionBatchV2 } from "../decisions/types-v2.js";
import { executeDecisionHttp, type DecisionHttpExecution } from "./decisions-http-runtime.js";

export { supportsOpenAIDecisionBatch } from "../decisions/openai-codec.js";

type Context = Parameters<DecisionProviderV2["evaluate"]>[1];

/** Retain the supported prepared-context entry point as a projection into explicit execution. */
export async function evaluateOpenAICompatibleDecision(
  batch: DecisionBatchV2,
  context: Context,
  route: { provider: string; baseUrl: string; modelId?: string },
): Promise<ProviderDecisionOutcomeV2> {
  return executeOpenAIDecision(batch, {
    provider: route.provider,
    modelId: route.modelId ?? context.model.id,
    baseUrl: route.baseUrl,
    headers: context.model.headers,
    auth: context.auth,
    request: getModelProviderRequestTransport(context.model),
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    reasoning: context.reasoning,
  });
}

export type OpenAIDecisionExecution = Omit<
  DecisionHttpExecution,
  "endpointPath" | "body" | "decode"
> & {
  readonly modelId: string;
  readonly reasoning?: Context["reasoning"];
};

/** Execute the OpenAI Decisions wire format; never fall back to conversational inference. */
export async function executeOpenAIDecision(
  batch: DecisionBatchV2,
  execution: OpenAIDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  execution.signal.throwIfAborted();
  if (!supportsOpenAIDecisionBatch(batch, execution.reasoning)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return executeDecisionHttp({
    ...execution,
    endpointPath: "decisions",
    body: JSON.stringify(encodeOpenAIDecisionRequest(batch, execution.modelId)),
    decode: (payload) => decodeOpenAIDecisionResult(batch, payload),
  });
}
