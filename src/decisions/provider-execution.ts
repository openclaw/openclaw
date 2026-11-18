import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import type { DecisionProviderContextV2 } from "./provider-context.js";
import type { ProviderDecisionOutcomeV2 } from "./provider-outcomes.js";
import type { DecisionProviderV2 } from "./provider-types.js";
import { validateAdmittedDecisionResultV2 } from "./result-validation.js";
import type { DecisionBatchV2 } from "./types-v2.js";

/** Invoked and awaited within the prepared model's lifetime, with host-owned validation facts. */
export async function evaluatePreparedDecisionProvider(params: {
  provider: DecisionProviderV2;
  batch: DecisionBatchV2;
  offered: DecisionBatchV2;
  context: DecisionProviderContextV2;
  capabilities: ModelDecisionCapabilities | undefined;
  isAdmissible: () => boolean;
}): Promise<ProviderDecisionOutcomeV2> {
  const result = await params.provider.evaluate(params.batch, params.context);
  if (!params.isAdmissible()) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const status = result.status;
  if (status === "ok") {
    const value = result.result;
    if (!validateAdmittedDecisionResultV2(params.offered, value, params.capabilities)) {
      return { status: "unavailable", reason: "invalid-response" };
    }
    params.isAdmissible();
    return { status, result: value };
  }
  if (status !== "unavailable") {
    throw new Error("Invalid decision provider outcome");
  }
  const { reason, retryAfterMs } = result;
  params.isAdmissible();
  return { status, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}
