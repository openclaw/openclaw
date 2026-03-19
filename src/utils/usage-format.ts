import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { modelKey, normalizeModelRef, normalizeProviderId } from "../agents/model-selection.js";
import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { getCachedGatewayModelPricing } from "../gateway/model-pricing-cache.js";

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

type ModelsJsonCostCache = {
  path: string;
  mtimeMs: number;
  entries: Map<string, ModelCostConfig>;
};

let modelsJsonCostCache: ModelsJsonCostCache | null = null;

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    const precision = safe >= 10_000 ? 0 : 1;
    const formattedThousands = (safe / 1_000).toFixed(precision);
    if (Number(formattedThousands) >= 1_000) {
      return `${(safe / 1_000_000).toFixed(1)}m`;
    }
    return `${formattedThousands}k`;
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

function toResolvedModelKey(params: { provider?: string; model?: string }): string | null {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return null;
  }
  const normalized = normalizeModelRef(provider, model);
  return modelKey(normalized.provider, normalized.model);
}

function buildProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
): Map<string, ModelCostConfig> {
  const entries = new Map<string, ModelCostConfig>();
  if (!providers) {
    return entries;
  }
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeProviderId(providerKey);
    for (const model of providerConfig?.models ?? []) {
      const normalized = normalizeModelRef(normalizedProvider, model.id);
      entries.set(modelKey(normalized.provider, normalized.model), model.cost);
    }
  }
  return entries;
}

/**
 * Injectable loader for Model Cost data.
 * Allows tests to inject mocked fs/path implementations without
 * relying on global mutable state or fragile jest.mock patterns.
 */
export class CostIndexLoader {
  private cache: CostCache | null = null;

  constructor(
    private readonly fs: typeof import("fs"),
    private readonly path: typeof import("path"),
    private readonly resolveDir: () => string,
  ) {}

  load(): Map<string, ModelCostConfig> {
    const modelsPath = this.path.join(this.resolveDir(), "models.json");
    try {
      const stat = this.fs.statSync(modelsPath);
      if (this.cache && this.cache.path === modelsPath && this.cache.mtimeMs === stat.mtimeMs) {
        return this.cache.entries;
      }

      const parsed = JSON.parse(this.fs.readFileSync(modelsPath, "utf8")) as {
        providers?: Record<string, ModelProviderConfig>;
      };

      const entries = this.buildProviderCostIndex(parsed.providers);
      this.cache = {
        path: modelsPath,
        mtimeMs: stat.mtimeMs,
        entries,
      };
      return entries;
    } catch {
      const empty = new Map<string, ModelCostConfig>();
      this.cache = {
        path: modelsPath,
        mtimeMs: -1,
        entries: empty,
      };
      return empty;
    }
  }

  private buildProviderCostIndex(
    providers: Record<string, ModelProviderConfig> | undefined,
  ): Map<string, ModelCostConfig> {
    const entries = new Map<string, ModelCostConfig>();
    if (!providers) {
      return entries;
    }
    for (const [providerKey, providerConfig] of Object.entries(providers)) {
      const normalizedProvider = normalizeProviderId(providerKey);
      for (const model of providerConfig?.models ?? []) {
        const normalized = normalizeModelRef(normalizedProvider, model.id);
        entries.set(modelKey(normalized.provider, normalized.model), model.cost);
      }
    }
    return entries;
  }
}

// Default singleton instance for use in production code.
// Production code can simply use `defaultLoader.load()`.
export const defaultLoader = new CostIndexLoader(fs, path, resolveOpenClawAgentDir);

// Helper to maintain backward compatibility with existing function calls if necessary,
// or to be replaced by direct `defaultLoader` usage.
export function loadModelsJsonCostIndex(): Map<string, ModelCostConfig> {
  return defaultLoader.load();
}

function findConfiguredProviderCost(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const key = toResolvedModelKey(params);
  if (!key) {
    return undefined;
  }
  return buildProviderCostIndex(params.config?.models?.providers).get(key);
}

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const key = toResolvedModelKey(params);
  if (!key) {
    return undefined;
  }

  const modelsJsonCost = loadModelsJsonCostIndex().get(key);
  if (modelsJsonCost) {
    return modelsJsonCost;
  }

  const configuredCost = findConfiguredProviderCost(params);
  if (configuredCost) {
    return configuredCost;
  }

  return getCachedGatewayModelPricing(params);
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

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

export function __resetUsageFormatCachesForTest(): void {
  modelsJsonCostCache = null;
}
