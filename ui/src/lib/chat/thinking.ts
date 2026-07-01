// Control UI module implements thinking behavior.
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max") {
    return "max";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off" || key === "none") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): readonly string[] {
  void provider;
  void model;
  return BASE_THINKING_LEVELS;
}

export function formatThinkingLevels(provider?: string | null, model?: string | null): string {
  return listThinkingLevelLabels(provider, model).join(", ");
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): string {
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}

export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

export function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  const normalized = effectiveLevel ? normalizeThinkingOptionValue(effectiveLevel) : "off";
  return `Inherited: ${formatThinkingLevelDisplayLabel(normalized)}`;
}

export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") {
    return "Off";
  }
  return formatThinkingLevelDisplayLabel(label?.trim() || normalized);
}

function formatThinkingLevelDisplayLabel(value: string): string {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (["on", "enable", "enabled"].includes(raw)) {
    return "On";
  }
  const normalized = normalizeThinkingOptionValue(value);
  switch (normalized) {
    case "adaptive":
      return "Adaptive";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
