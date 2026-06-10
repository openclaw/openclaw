// Normalizes config.patch replacePaths shared by Gateway and agent preflight checks.
export function normalizeConfigPatchReplacePath(value: string): string {
  return value.trim().replace(/\[(?:\d*)\]/g, "[]");
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
