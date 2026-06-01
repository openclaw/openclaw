import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

function resolvePerMillionRate(
  model: Model<Api>,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
  inputTokens: number,
): number {
  const tiers = model.cost.tieredPricing;
  if (!tiers || tiers.length === 0) {
    return model.cost[key];
  }
  for (const tier of tiers) {
    const [start, rawEnd] = tier.range;
    const end = rawEnd ?? Number.POSITIVE_INFINITY;
    if (inputTokens >= start && inputTokens < end) {
      return tier[key];
    }
  }
  return model.cost[key];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  const inputRate = resolvePerMillionRate(model, "input", usage.input);
  const outputRate = resolvePerMillionRate(model, "output", usage.input);
  const cacheReadRate = resolvePerMillionRate(model, "cacheRead", usage.input);
  const cacheWriteRate = resolvePerMillionRate(model, "cacheWrite", usage.input);
  usage.cost.input = (inputRate / 1000000) * usage.input;
  usage.cost.output = (outputRate / 1000000) * usage.output;
  usage.cost.cacheRead = (cacheReadRate / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (cacheWriteRate / 1000000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  if (!model.reasoning) {
    return ["off"];
  }

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.id === b.id && a.provider === b.provider;
}
