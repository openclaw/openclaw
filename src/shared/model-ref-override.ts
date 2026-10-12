/** Preserve model-only overrides and whitespace inside provider/model segments. */
export function resolveModelRefOverride(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}
