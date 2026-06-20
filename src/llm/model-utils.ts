// Provides model selection, usage, and thinking-level utility helpers.
import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
} from "@openclaw/llm-core";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
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

type CompatReasoningEffortConfig = {
  reasoningEffortMap?: unknown;
  supportedReasoningEfforts?: unknown;
};

const normalizeReasoningEffort = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

function resolveThinkingLevelMap<TApi extends Api>(model: Model<TApi>) {
  return model.api === "anthropic-messages"
    ? (resolveClaudeNativeThinkingLevelMap(model) ?? model.thinkingLevelMap)
    : model.thinkingLevelMap;
}

function getCompatReasoningEffortConfig<TApi extends Api>(
  model: Model<TApi>,
): CompatReasoningEffortConfig | undefined {
  const compat = (model as { compat?: unknown }).compat;
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  return compat as CompatReasoningEffortConfig;
}

function getCompatSupportedReasoningEfforts(
  compat: CompatReasoningEffortConfig | undefined,
): Set<string> {
  if (!Array.isArray(compat?.supportedReasoningEfforts)) {
    return new Set();
  }
  return new Set(
    compat.supportedReasoningEfforts
      .map((effort) => normalizeReasoningEffort(effort))
      .filter(Boolean),
  );
}

function getCompatReasoningEffortMap(
  compat: CompatReasoningEffortConfig | undefined,
): Record<string, unknown> | undefined {
  const map = compat?.reasoningEffortMap;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return undefined;
  }
  return map as Record<string, unknown>;
}

function mappedReasoningEffortIsSupported(mapped: unknown, supportedEfforts: Set<string>): boolean {
  const normalized = normalizeReasoningEffort(mapped);
  if (!normalized) {
    return false;
  }
  return (
    supportedEfforts.size === 0 ||
    supportedEfforts.has(normalized) ||
    (normalized === "max" && supportedEfforts.has("xhigh"))
  );
}

function compatExplicitlySupportsExtendedThinkingLevel(
  level: ModelThinkingLevel,
  mapped: unknown,
  supportedEfforts: Set<string>,
): boolean {
  const normalizedMapped = normalizeReasoningEffort(mapped);

  if (level === "max") {
    // Runtime transports currently serialize the OpenClaw `max` level as provider `xhigh`.
    // Keep `max` hidden unless compat metadata explicitly opts into that safe alias.
    return normalizedMapped === "xhigh" && supportedEfforts.has("xhigh");
  }

  if (supportedEfforts.has(level)) {
    return true;
  }

  return false;
}

function compatSupportsThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): boolean {
  const compat = getCompatReasoningEffortConfig(model);
  const supportedEfforts = getCompatSupportedReasoningEfforts(compat);
  const effortMap = getCompatReasoningEffortMap(compat);
  const mappedEffort = effortMap?.[level];
  if (mappedEffort === null) {
    return false;
  }

  if (!compatExplicitlySupportsExtendedThinkingLevel(level, mappedEffort, supportedEfforts)) {
    return false;
  }

  if (mappedReasoningEffortIsSupported(mappedEffort, supportedEfforts)) {
    return true;
  }

  if (supportedEfforts.has(level)) {
    return true;
  }

  return false;
}

/** Returns thinking levels exposed by a reasoning-capable model. */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  const fableContract =
    model.api === "anthropic-messages" && resolveClaudeFable5ModelIdentity(model) !== undefined;
  if (!model.reasoning && !fableContract) {
    return ["off"];
  }
  const thinkingLevelMap = resolveThinkingLevelMap(model);

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined || compatSupportsThinkingLevel(model, level);
    }
    return true;
  });
}

/** Clamps a requested thinking level to the closest supported level for a model. */
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

  // Explicit provider opt-outs are hard caps. Downgrade them before considering
  // stronger levels so unsupported xhigh/max requests cannot increase cost.
  const thinkingLevelMap = resolveThinkingLevelMap(model);
  if ((level === "xhigh" || level === "max") && thinkingLevelMap?.[level] === null) {
    for (let i = requestedIndex - 1; i >= 0; i--) {
      const candidate = EXTENDED_THINKING_LEVELS[i];
      if (availableLevels.includes(candidate)) {
        return candidate;
      }
    }
  }

  // Prefer the next stronger available level, then walk down if the request was above the model cap.
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

/** Compares model identity by provider and id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.id === b.id && a.provider === b.provider;
}
