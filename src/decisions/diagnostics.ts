import { createHash } from "node:crypto";
import { createFixedWindowBudget } from "../infra/fixed-window-rate-limit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DecisionProviderCapabilities } from "../plugins/manifest-types.js";
import type { DecisionInputEstimate } from "./input-budget.js";
import type { DecisionOutcome, DecisionRuntimeV1 } from "./types.js";

const log = createSubsystemLogger("decisions");
const warnings = createFixedWindowBudget({ maxRequests: 1, windowMs: 60_000 });

export type DecisionEvaluationFacts = {
  estimate?: DecisionInputEstimate;
  dispatched: boolean;
};

export function decisionDebugEnabled(): boolean {
  return log.isEnabled("debug");
}

// Purpose/model identifiers are caller/plugin-authored too. Correlate, never retain raw text.
const reference = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export function logDecisionEvaluation(params: {
  options: Parameters<DecisionRuntimeV1["evaluate"]>[1];
  providerId?: string;
  model?: string;
  capabilities?: DecisionProviderCapabilities;
  facts: DecisionEvaluationFacts;
  started: number;
  outcome?: DecisionOutcome;
}): void {
  const { options, capabilities, facts, outcome } = params;
  const issue = outcome?.status === "unavailable" ? outcome.inputIssue : undefined;
  if (
    (issue === "estimated-budget-exceeded" || issue === "provider-context-overflow") &&
    log.isEnabled("warn") &&
    warnings.consume().allowed
  ) {
    log.warn("Decision input exceeds model budget; caller retains its fallback policy.", {
      inputIssue: issue,
    });
  }
  if (!decisionDebugEnabled()) {
    return;
  }
  // The logger supplies existing ambient run trace correlation. No new audit collection.
  log.debug("Decision evaluation completed", {
    purposeRef: reference(options.purpose),
    ...(params.providerId ? { providerRef: reference(params.providerId) } : {}),
    ...(params.model ? { modelRef: reference(params.model) } : {}),
    limitSource: capabilities ? "provider-manifest" : "unknown",
    inputTokenScope: capabilities?.inputTokenScope ?? "unknown",
    maxInputTokens: capabilities?.maxInputTokens ?? null,
    maxTotalInputTokens: capabilities?.maxTotalInputTokens ?? null,
    inputBudgetPolicy: options.inputBudgetPolicy ?? "none",
    ...facts.estimate,
    providerDispatched: facts.dispatched,
    status: outcome?.status ?? "rejected",
    ...(outcome?.status === "unavailable" ? { reason: outcome.reason, inputIssue: issue } : {}),
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
