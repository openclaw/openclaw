import type { ModelCostConfig } from "@openclaw/llm-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareModelPricingContext } from "../model-catalog/pricing.js";
import {
  captureModelCostPricing,
  resolveModelCostConfigFingerprint,
  type CapturedModelCostPricing,
} from "../utils/usage-format.js";
import {
  applyUsageCostEstimate,
  needsUsageCostEstimate,
  parseUsageCostTranscriptRecord,
  type UsageCostResolver,
} from "./session-cost-usage-pricing.js";
import type { ParsedTranscriptEntry } from "./session-cost-usage.types.js";

export async function resolveUsageCostPricingFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
): Promise<string> {
  await prepareModelPricingContext(config);
  return resolveModelCostConfigFingerprint(config, agentDir);
}

export async function prepareUsageCostPricing(
  config?: OpenClawConfig,
  agentDir?: string,
): Promise<CapturedModelCostPricing> {
  await prepareModelPricingContext(config);
  return captureModelCostPricing(config, agentDir);
}

export function createUsageCostResolver(
  params?: { config?: OpenClawConfig; agentDir?: string },
  pricing?: CapturedModelCostPricing,
): UsageCostResolver {
  let capturedPricing = pricing;
  const cache = new Map<string, ModelCostConfig | undefined>();
  return ({ provider, model }) => {
    const key = `${provider ?? ""}\0${model ?? ""}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    // Diagnostic readers enter pricing only after the first unpriced record is prepared.
    capturedPricing ??= captureModelCostPricing(params?.config, params?.agentDir);
    const cost = capturedPricing.resolve(provider, model);
    cache.set(key, cost);
    return cost;
  };
}

/** Diagnostic readers prepare only when a record actually needs an estimate. */
export async function parseUsageCostTranscriptEntryAsync(
  parsed: Record<string, unknown>,
  resolveCost: UsageCostResolver,
  config?: OpenClawConfig,
): Promise<ParsedTranscriptEntry | null> {
  const entry = parseUsageCostTranscriptRecord(parsed);
  if (!needsUsageCostEstimate(entry)) {
    return entry;
  }
  await prepareModelPricingContext(config);
  return applyUsageCostEstimate(entry, resolveCost);
}
