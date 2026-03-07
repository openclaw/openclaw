export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
export type VerboseLevel = "off" | "on" | "full";
export type NoticeLevel = "off" | "on" | "full";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ElevatedMode = "off" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "tokens" | "full";

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.2",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.1-codex",
  "github-copilot/gpt-5.2-codex",
  "github-copilot/gpt-5.2",
] as const;

const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(
  XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter(
    (entry): entry is string => Boolean(entry),
  ),
);

// O(1) lookup table for think level normalization (replaces chained Array.includes).
const THINK_LEVEL_MAP = new Map<string, ThinkLevel>([
  ["adaptive", "adaptive"],
  ["auto", "adaptive"],
  ["xhigh", "xhigh"],
  ["extrahigh", "xhigh"],
  ["off", "off"],
  ["on", "low"],
  ["enable", "low"],
  ["enabled", "low"],
  ["min", "minimal"],
  ["minimal", "minimal"],
  ["think", "minimal"],
  ["low", "low"],
  ["thinkhard", "low"],
  ["think-hard", "low"],
  ["think_hard", "low"],
  ["mid", "medium"],
  ["med", "medium"],
  ["medium", "medium"],
  ["thinkharder", "medium"],
  ["think-harder", "medium"],
  ["harder", "medium"],
  ["high", "high"],
  ["ultra", "high"],
  ["ultrathink", "high"],
  ["thinkhardest", "high"],
  ["highest", "high"],
  ["max", "high"],
]);

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const direct = THINK_LEVEL_MAP.get(key);
  if (direct) {
    return direct;
  }
  // Collapse separators for compound aliases (e.g. "think hard" -> "thinkhard")
  const collapsed = key.replace(/[\s_-]+/g, "");
  return THINK_LEVEL_MAP.get(collapsed);
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = model?.trim().toLowerCase();
  if (!modelKey) {
    return false;
  }
  const providerKey = provider?.trim().toLowerCase();
  if (providerKey) {
    return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
  }
  return XHIGH_MODEL_IDS.has(modelKey);
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
  if (supportsXHighThinking(provider, model)) {
    levels.push("xhigh");
  }
  levels.push("adaptive");
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider)) {
    return ["off", "on"];
  }
  return listThinkingLevels(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return listThinkingLevelLabels(provider, model).join(separator);
}

export function formatXHighModelHint(): string {
  const refs = [...XHIGH_MODEL_REFS] as string[];
  if (refs.length === 0) {
    return "unknown model";
  }
  if (refs.length === 1) {
    return refs[0];
  }
  if (refs.length === 2) {
    return `${refs[0]} or ${refs[1]}`;
  }
  return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}

type OnOffFullLevel = "off" | "on" | "full";

// O(1) lookup table for on/off/full normalization.
const ON_OFF_FULL_MAP = new Map<string, OnOffFullLevel>([
  ["off", "off"],
  ["false", "off"],
  ["no", "off"],
  ["0", "off"],
  ["full", "full"],
  ["all", "full"],
  ["everything", "full"],
  ["on", "on"],
  ["minimal", "on"],
  ["true", "on"],
  ["yes", "on"],
  ["1", "on"],
]);

function normalizeOnOffFullLevel(raw?: string | null): OnOffFullLevel | undefined {
  if (!raw) {
    return undefined;
  }
  return ON_OFF_FULL_MAP.get(raw.toLowerCase());
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

// Normalize system notice flags used to toggle system notifications.
export function normalizeNoticeLevel(raw?: string | null): NoticeLevel | undefined {
  return normalizeOnOffFullLevel(raw);
}

// O(1) lookup table for usage display level normalization.
const USAGE_DISPLAY_MAP = new Map<string, UsageDisplayLevel>([
  ["off", "off"],
  ["false", "off"],
  ["no", "off"],
  ["0", "off"],
  ["disable", "off"],
  ["disabled", "off"],
  ["on", "tokens"],
  ["true", "tokens"],
  ["yes", "tokens"],
  ["1", "tokens"],
  ["enable", "tokens"],
  ["enabled", "tokens"],
  ["tokens", "tokens"],
  ["token", "tokens"],
  ["tok", "tokens"],
  ["minimal", "tokens"],
  ["min", "tokens"],
  ["full", "full"],
  ["session", "full"],
]);

// Normalize response-usage display modes used to toggle per-response usage footers.
export function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined {
  if (!raw) {
    return undefined;
  }
  return USAGE_DISPLAY_MAP.get(raw.toLowerCase());
}

export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

// O(1) lookup table for elevated level normalization.
const ELEVATED_LEVEL_MAP = new Map<string, ElevatedLevel>([
  ["off", "off"],
  ["false", "off"],
  ["no", "off"],
  ["0", "off"],
  ["full", "full"],
  ["auto", "full"],
  ["auto-approve", "full"],
  ["autoapprove", "full"],
  ["ask", "ask"],
  ["prompt", "ask"],
  ["approval", "ask"],
  ["approve", "ask"],
  ["on", "on"],
  ["true", "on"],
  ["yes", "on"],
  ["1", "on"],
]);

// Normalize elevated flags used to toggle elevated bash permissions.
export function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined {
  if (!raw) {
    return undefined;
  }
  return ELEVATED_LEVEL_MAP.get(raw.toLowerCase());
}

export function resolveElevatedMode(level?: ElevatedLevel | null): ElevatedMode {
  if (!level || level === "off") {
    return "off";
  }
  if (level === "full") {
    return "full";
  }
  return "ask";
}

// O(1) lookup table for reasoning level normalization.
const REASONING_LEVEL_MAP = new Map<string, ReasoningLevel>([
  ["off", "off"],
  ["false", "off"],
  ["no", "off"],
  ["0", "off"],
  ["hide", "off"],
  ["hidden", "off"],
  ["disable", "off"],
  ["disabled", "off"],
  ["on", "on"],
  ["true", "on"],
  ["yes", "on"],
  ["1", "on"],
  ["show", "on"],
  ["visible", "on"],
  ["enable", "on"],
  ["enabled", "on"],
  ["stream", "stream"],
  ["streaming", "stream"],
  ["draft", "stream"],
  ["live", "stream"],
]);

// Normalize reasoning visibility flags used to toggle reasoning exposure.
export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
  if (!raw) {
    return undefined;
  }
  return REASONING_LEVEL_MAP.get(raw.toLowerCase());
}
