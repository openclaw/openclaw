export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}
