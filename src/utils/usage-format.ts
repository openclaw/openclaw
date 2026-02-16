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

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

// Cost per 1M tokens (USD)
const DEFAULT_MODEL_COSTS: Record<string, ModelCostConfig> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }, // 2024-08 pricing
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  "gpt-4-turbo": { input: 10, output: 30, cacheRead: 10, cacheWrite: 10 },
  
  // Anthropic
  "claude-3-5-sonnet-20240620": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-opus-20240229": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  
  // Google
  "gemini-1.5-pro": { input: 3.5, output: 10.5, cacheRead: 0.875, cacheWrite: 3.5 }, // approximate
  "gemini-1.5-flash": { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
  
  // DeepSeek (approx)
  "deepseek-chat": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
};

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!model) {
    return undefined;
  }
  
  // 1. Check user config overrides
  if (provider && params.config?.models?.providers) {
    const providers = params.config.models.providers;
    const entry = providers[provider]?.models?.find((item) => item.id === model);
    if (entry?.cost) {
      return entry.cost;
    }
  }

  // 2. Check default costs map
  const normalized = model.toLowerCase();
  for (const [key, cost] of Object.entries(DEFAULT_MODEL_COSTS)) {
    if (normalized === key) {
      return cost;
    }
  }
  // Fuzzy match: if config model is "anthropic/claude-3-5-sonnet-20240620"
  for (const [key, cost] of Object.entries(DEFAULT_MODEL_COSTS)) {
    if (normalized.endsWith(key)) {
      return cost;
    }
  }

  return undefined;
}

export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) {
    return undefined;
  }
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);
  const total =
    input * cost.input +
    output * cost.output +
    cacheRead * cost.cacheRead +
    cacheWrite * cost.cacheWrite;
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}
