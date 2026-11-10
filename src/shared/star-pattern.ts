/**
 * Matches prepared star segments without regex backtracking.
 * Callers own normalization and case; ordered matching is bounded by the
 * suffix so prefix, interior and suffix segments cannot overlap.
 */
export function matchesStarSegments(
  pattern: { first: string; last: string; interior: readonly string[] },
  value: string,
): boolean {
  if (!value.startsWith(pattern.first)) {
    return false;
  }
  let pos = pattern.first.length;
  const endBound = pattern.last ? value.length - pattern.last.length : value.length;
  if (pattern.last && (!value.endsWith(pattern.last) || endBound < pos)) {
    return false;
  }
  for (const part of pattern.interior) {
    const idx = value.indexOf(part, pos);
    if (idx === -1 || idx + part.length > endBound) {
      return false;
    }
    pos = idx + part.length;
  }
  return true;
}
