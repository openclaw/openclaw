import { ALL_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { formatThinkingOverrideLabel, normalizeThinkingOptionValue } from "./thinking.ts";

// Settings pages only: kept out of the chat-boot thinking module so it stays out of boot JS.
const STANDARD_THINKING_LEVELS = new Set<string>(ALL_THINKING_LEVELS);

/**
 * Standard levels use the translated names; provider-specific levels keep their own label.
 * Callers pass their reactive translator so labels follow locale changes.
 */
export function thinkingLevelLabel(
  translate: (key: string) => string,
  value: string,
  label?: string,
): string {
  const level = normalizeThinkingOptionValue(value);
  return STANDARD_THINKING_LEVELS.has(level)
    ? translate(`quickSettings.model.thinkingLevels.${level}`)
    : formatThinkingOverrideLabel(value, label);
}
