// Normalizes config.patch replacePaths shared by Gateway and agent preflight checks.
export function normalizeConfigPatchReplacePath(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/\[\d+\]/g, "[]");
  return trimmed.endsWith("[]") ? normalized.slice(0, -2) : normalized;
}

export function normalizeConfigPatchReplacePaths(
  values: readonly unknown[] | undefined,
): Set<string> {
  if (!values) {
    return new Set();
  }
  return new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map(normalizeConfigPatchReplacePath)
      .filter((value) => value.length > 0),
  );
}
