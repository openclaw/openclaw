export function normalizePackageTagInput(
  value: string | undefined | null,
  packageNames: readonly string[],
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  for (const packageName of packageNames) {
    const prefix = `${packageName}@`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  return trimmed;
}
