export function formatTargetHint(hint?: string, withLabel = false): string {
  if (!hint) return "";
  return withLabel ? ` Hint: ${hint}` : ` ${hint}`;
}
