import type { ModelCatalogEntry } from "../../../../src/agents/model-catalog.js";

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "adaptive" | "xhigh";
export type VerboseLevel = "off" | "on" | "full";

const THINK_LEVELS = new Set<ThinkLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "adaptive",
  "xhigh",
]);

export function normalizeThinkLevel(value: unknown): ThinkLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return THINK_LEVELS.has(normalized as ThinkLevel) ? (normalized as ThinkLevel) : undefined;
}

export function normalizeVerboseLevel(value: unknown): VerboseLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "on" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

export function formatThinkingLevels(_provider?: string, _model?: string): string {
  return "off, minimal, low, medium, high, adaptive";
}

export function resolveThinkingDefaultForModel(params: {
  provider?: string;
  model?: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim().toLowerCase();
  const catalog = Array.isArray(params.catalog) ? params.catalog : [];
  const found = catalog.find((entry) => {
    const id = String(entry?.id ?? "")
      .trim()
      .toLowerCase();
    const entryProvider = String(entry?.provider ?? "")
      .trim()
      .toLowerCase();
    return id === model && (!provider || !entryProvider || entryProvider === provider);
  });
  if (found?.reasoning === true) {
    return "low";
  }
  return "off";
}
