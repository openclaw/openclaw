import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(safe));
}

export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const providers = params.config?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  return entry?.cost;
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
  provider?: string;
  model?: string;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim().toLowerCase();
  
  if (!usage || !cost) {
    return undefined;
  }
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);

  // Calculate input cost with cache hit pricing
  let inputCost = input * cost.input;
  if (cacheRead > 0 && input > 0) {
    const cacheMissInput = Math.max(0, input - cacheRead);
    const cacheHitInput = cacheRead;
    
    // Get cache hit price based on provider
    let cacheHitPrice = cost.cacheRead || cost.input * 0.1; // Default to 10% of input price
    
    // Provider-specific cache hit pricing
    if (provider === "deepseek") {
      cacheHitPrice = 0.028; // DeepSeek cache hit price
    } else if (provider === "moonshot") {
      cacheHitPrice = 0.10; // Kimi cache hit price for kimi-k2.5
    } else if (provider === "minimax") {
      cacheHitPrice = cost.cacheRead || 0.03; // MiniMax cache read price
    }
    
    inputCost = cacheMissInput * cost.input + cacheHitInput * cacheHitPrice;
  }
  
  const outputCost = output * cost.output;
  const cacheReadCost = cacheRead * (cost.cacheRead || 0);
  const cacheWriteCost = cacheWrite * (cost.cacheWrite || 0);
  
  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}
