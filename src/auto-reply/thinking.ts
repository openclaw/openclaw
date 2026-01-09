export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";
export type VerboseLevel = "off" | "on";
export type ElevatedLevel = "off" | "on";
export type ReasoningLevel = "off" | "on" | "stream";
export type UsageDisplayLevel = "off" | "on";

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(
  raw?: string | null,
): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off"].includes(key)) return "off";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key))
    return "low";
  if (
    ["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(
      key,
    )
  )
    return "medium";
  if (
    [
      "high",
      "ultra",
      "ultrathink",
      "think-hard",
      "thinkhardest",
      "highest",
      "max",
    ].includes(key)
  )
    return "high";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(
  raw?: string | null,
): VerboseLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["on", "full", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

// Normalize response-usage display flags used to toggle cost/token lines.
export function normalizeUsageDisplay(
  raw?: string | null,
): UsageDisplayLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0", "disable", "disabled"].includes(key))
    return "off";
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(key))
    return "on";
  return undefined;
}

// Normalize elevated flags used to toggle elevated bash permissions.
export function normalizeElevatedLevel(
  raw?: string | null,
): ElevatedLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["on", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

// Normalize reasoning visibility flags used to toggle reasoning exposure.
export function normalizeReasoningLevel(
  raw?: string | null,
): ReasoningLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (
    [
      "off",
      "false",
      "no",
      "0",
      "hide",
      "hidden",
      "disable",
      "disabled",
    ].includes(key)
  )
    return "off";
  if (
    ["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(
      key,
    )
  )
    return "on";
  if (["stream", "streaming", "draft", "live"].includes(key)) return "stream";
  return undefined;
}
