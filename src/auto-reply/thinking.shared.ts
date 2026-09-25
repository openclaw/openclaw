/** Shared normalization for thinking, verbosity, tracing, reasoning, and usage directives. */
import {
  type FastMode,
  normalizeFastMode,
  normalizeOptionalLowercaseString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { ThinkingLevelMap } from "../llm/types.js";

export { normalizeFastMode };
export type { FastMode };

/** Canonical thinking level values accepted by chat commands and session state. */
const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
] as const;
export type ThinkLevel = (typeof ALL_THINKING_LEVELS)[number];
export type VerboseLevel = "off" | "on" | "full";
export type TraceLevel = "off" | "on" | "raw";
export type ElevatedLevel = "off" | "on" | "ask" | "full";
export type ReasoningLevel = "off" | "on" | "stream";
type UsageDisplayLevel = "off" | "tokens" | "full";
/** Prepared model catalog fields reused while choosing and dispatching a queued runtime. */
export type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  nativeRuntime?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  configuredReasoning?: boolean;
  /** Concrete runtime owner of thinking policy; internal and never project to clients. */
  thinkingPolicyProvider?: string;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: readonly ("text" | "image" | "audio" | "video" | "document")[];
  params?: Record<string, unknown>;
  compat?: {
    thinkingFormat?: string;
    supportsReasoningEffort?: boolean;
    supportedReasoningEfforts?: readonly string[] | null;
    reasoningEffortMap?: Record<string, string>;
  } | null;
};

export const THINKING_LEVELS_HELP = ALL_THINKING_LEVELS.join("|");
export const BASE_THINKING_LEVELS: ThinkLevel[] = ["off", "minimal", "low", "medium", "high"];
export const THINKING_LEVEL_RANKS: Record<ThinkLevel, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  adaptive: 30,
  xhigh: 60,
  max: 70,
  ultra: 80,
};

/** Normalizes user-provided thinking level strings to the canonical enum. */
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return undefined;
  }
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max" || collapsed === "maximum") {
    return "max";
  }
  if (collapsed === "ultra") {
    return "ultra";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  // `none` is a documented provider-native spelling for disabled reasoning; store canonical off.
  if (["off", "none"].includes(key)) {
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
  if (["high", "ultrathink", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (["think"].includes(key)) {
    return "minimal";
  }
  return undefined;
}

/** Returns true for command values that clear an inherited session override. */
export function isSessionDefaultDirectiveValue(raw?: string | null): boolean {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return false;
  }
  return ["default", "inherit", "inherited", "clear", "reset", "unpin"].includes(key);
}

function normalizeAliasedLevel<T extends string>(
  raw: string | null | undefined,
  aliases: ReadonlyArray<readonly [T, ...string[]]>,
): T | undefined {
  const key = normalizeOptionalLowercaseString(raw);
  return key ? aliases.find((group) => group.includes(key))?.[0] : undefined;
}

/** Normalizes /verbose values. */
export function normalizeVerboseLevel(raw?: string | null): VerboseLevel | undefined {
  return normalizeAliasedLevel(raw, [
    ["off", "false", "no", "0"],
    ["full", "all", "everything"],
    ["on", "minimal", "true", "yes", "1"],
  ]);
}

/** Normalizes /trace values. */
export function normalizeTraceLevel(raw?: string | null): TraceLevel | undefined {
  return normalizeAliasedLevel(raw, [
    ["off", "false", "no", "0"],
    ["on", "true", "yes", "1"],
    ["raw", "unfiltered"],
  ]);
}

/** Normalizes response usage display values. */
export function normalizeUsageDisplay(raw?: string | null): UsageDisplayLevel | undefined {
  return normalizeAliasedLevel(raw, [
    ["off", "false", "no", "0", "disable", "disabled"],
    ["tokens", "token", "tok", "minimal", "min", "on", "true", "yes", "1", "enable", "enabled"],
    ["full", "session"],
  ]);
}

/** Resolves response usage display mode with the persisted default. */
export function resolveResponseUsageMode(raw?: string | null): UsageDisplayLevel {
  return normalizeUsageDisplay(raw) ?? "off";
}

type ResponseUsageInput = "on" | "off" | "tokens" | "full";
type ResponseUsageDefaultConfig =
  | ResponseUsageInput
  | { default?: ResponseUsageInput; [channel: string]: ResponseUsageInput | undefined };

function resolveMessagesResponseUsageDefault(
  configured: ResponseUsageDefaultConfig | undefined,
  channel?: string,
): ResponseUsageInput | undefined {
  if (typeof configured === "string") {
    return configured;
  }
  if (configured && typeof configured === "object") {
    return (channel ? configured[channel] : undefined) ?? configured.default;
  }
  return undefined;
}

export function resolveEffectiveResponseUsage(
  sessionRaw: string | undefined | null,
  configured: ResponseUsageDefaultConfig | undefined,
  channel?: string,
): UsageDisplayLevel {
  const sessionNormalized = normalizeUsageDisplay(sessionRaw);
  if (sessionNormalized !== undefined) {
    return sessionNormalized;
  }
  const configDefault = resolveMessagesResponseUsageDefault(configured, channel);
  return resolveResponseUsageMode(configDefault);
}

/** Normalizes elevated execution policy values. */
export function normalizeElevatedLevel(raw?: string | null): ElevatedLevel | undefined {
  return normalizeAliasedLevel(raw, [
    ["off", "false", "no", "0"],
    ["full", "auto", "auto-approve", "autoapprove"],
    ["ask", "prompt", "approval", "approve"],
    ["on", "true", "yes", "1"],
  ]);
}

/** Normalizes reasoning visibility values. */
export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
  return normalizeAliasedLevel(raw, [
    ["off", "false", "no", "0", "hide", "hidden", "disable", "disabled"],
    ["on", "true", "yes", "1", "show", "visible", "enable", "enabled"],
    ["stream", "streaming", "draft", "live"],
  ]);
}
