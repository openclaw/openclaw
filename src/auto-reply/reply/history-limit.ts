// Shared numeric policy for automatic observed-message context, not session transcript turns.
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/** Hard cap for prompt-injected history windows. JSON-schema integer maximum is not a window. */
const MAX_PROMPT_HISTORY_LIMIT = 200;

/** Resolves one bounded observed-message window without rewriting saved configuration. */
export function resolvePromptHistoryLimit(
  configured: unknown,
  fallback: number = DEFAULT_GROUP_HISTORY_LIMIT,
): number {
  const isSchemaMaximum =
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= Number.MAX_SAFE_INTEGER;
  const selected =
    typeof configured === "number" && Number.isFinite(configured) && !isSchemaMaximum
      ? configured
      : fallback;
  return Number.isFinite(selected)
    ? Math.min(Math.max(0, Math.trunc(selected)), MAX_PROMPT_HISTORY_LIMIT)
    : 0;
}
