export function concatOptionalTextSegments(params: {
  left?: string;
  right?: string;
  separator?: string;
}): string | undefined {
  const separator = params.separator ?? "\n\n";
  if (params.left && params.right) {
    return `${params.left}${separator}${params.right}`;
  }
  return params.right ?? params.left;
}

export function joinPresentTextSegments(
  segments: ReadonlyArray<string | null | undefined>,
  options?: {
    separator?: string;
    trim?: boolean;
  },
): string | undefined {
  const separator = options?.separator ?? "\n\n";
  const trim = options?.trim ?? false;
  const values: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "string") {
      continue;
    }
    const normalized = trim ? segment.trim() : segment;
    if (!normalized) {
      continue;
    }
    values.push(normalized);
  }
  return values.length > 0 ? values.join(separator) : undefined;
}

/**
 * Appends `suffix` to `base`, avoiding duplicating any overlapping string section
 * where the end of `base` matches the beginning of `suffix`.
 *
 * Uses a boundary-aware heuristic to distinguish between legitimate repeated
 * characters (like "bo" + "ok" -> "book") and redundant provider resends
 * (like "I hear you" + "you - hello" -> "I hear you - hello").
 */
export function appendUniqueSuffix(
  base: string,
  suffix: string,
  options?: { minOverlap?: number },
): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }

  const minOverlap = options?.minOverlap ?? 1;
  const maxOverlap = Math.min(base.length, suffix.length);

  for (let overlap = maxOverlap; overlap >= minOverlap; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      const overlapStr = suffix.slice(0, overlap);

      // Heuristic: Is this overlap a likely protocol resend or just a coincidence?
      // 1. Long overlaps (15+) are almost certainly resends.
      // 2. Overlaps containing spaces/punctuation are likely semantic resends.
      // 3. Short overlaps must start or end at a word/string boundary.
      // 4. 1-character overlaps are only merged if they are isolated by boundaries (e.g. spaces).

      const isBoundary = (char: string | undefined) => !char || /[\s.,!?;:()[\]{}'"]/.test(char);
      const hasInternalBoundary = /[\s.,!?;:()[\]{}'"]/.test(overlapStr);
      const atBaseBoundary = isBoundary(base[base.length - overlap - 1]);
      const atSuffixBoundary = isBoundary(suffix[overlap]);

      const isLikelyResend =
        overlap >= 15 ||
        hasInternalBoundary ||
        (overlap > 1 && (atBaseBoundary || atSuffixBoundary)) ||
        (overlap === 1 && atBaseBoundary && atSuffixBoundary);

      if (isLikelyResend) {
        return base + suffix.slice(overlap);
      }
    }
  }

  return base + suffix;
}
