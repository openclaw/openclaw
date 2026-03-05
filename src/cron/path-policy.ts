import { isRecord } from "../utils.js";
import type { CronAgentTurnPathPolicy } from "./types.js";

export function normalizeCronAgentTurnPathPolicy(
  value: unknown,
): CronAgentTurnPathPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalizeList = (list: unknown): string[] | undefined => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    const normalized = list
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      return undefined;
    }
    return [...new Set(normalized)];
  };

  const allow = normalizeList(value.allow);
  const deny = normalizeList(value.deny);
  if (!allow && !deny) {
    return undefined;
  }
  return {
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
  };
}
