import { createHash } from "node:crypto";
import { createFixedWindowBudget } from "../infra/fixed-window-rate-limit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DecisionOutcome, DecisionRuntimeV1 } from "./types.js";

const log = createSubsystemLogger("decisions");
const warnings = createFixedWindowBudget({ maxRequests: 1, windowMs: 60_000 });

export type DecisionEvaluationFacts = {
  dispatched: boolean;
  questionCount?: number;
  /** Serialized supplied JSON bytes, not model tokens or the provider wire payload. */
  jsonInputBytes?: number;
};

export function decisionDebugEnabled(): boolean {
  return log.isEnabled("debug");
}

// Caller/plugin-authored identifiers can contain private text too.
const reference = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export function logDecisionEvaluation(params: {
  options: Parameters<DecisionRuntimeV1["evaluate"]>[1];
  providerId?: string;
  model?: string;
  facts: DecisionEvaluationFacts;
  started: number;
  outcome?: DecisionOutcome;
}): void {
  const { options, facts, outcome } = params;
  if (
    outcome?.status === "unavailable" &&
    outcome.reason === "unsupported-input" &&
    log.isEnabled("warn") &&
    warnings.consume().allowed
  ) {
    // Unsupported input is not necessarily context overflow. Do not invent a cause.
    log.warn("Decision input was rejected; the caller retains its fallback policy.");
  }
  if (!decisionDebugEnabled()) {
    return;
  }
  // Existing ambient trace correlation comes from the logger, not a new audit store.
  log.debug("Decision evaluation completed", {
    purposeRef: reference(options.purpose),
    ...(params.providerId ? { providerRef: reference(params.providerId) } : {}),
    ...(params.model ? { modelRef: reference(params.model) } : {}),
    questionCount: facts.questionCount,
    jsonInputBytes: facts.jsonInputBytes,
    providerDispatched: facts.dispatched,
    status: outcome?.status ?? "rejected",
    ...(outcome?.status === "unavailable" ? { reason: outcome.reason } : {}),
    ...(outcome?.status === "ok"
      ? {
          actualInputTokens: outcome.result.usage?.inputTokens ?? null,
          actualOutputTokens: outcome.result.usage?.outputTokens ?? null,
        }
      : {}),
    latencyMs: Math.max(0, performance.now() - params.started),
    callerEffect: "not-observed",
  });
}
