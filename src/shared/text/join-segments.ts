/** Concatenates two optional text blocks, preserving the right block's explicit empty string. */
export function concatOptionalTextSegments(params: {
  left?: string;
  right?: string;
}): string | undefined {
  if (params.left && params.right) {
    return `${params.left}\n\n${params.right}`;
  }
  return params.right ?? params.left;
}

/** Joins non-empty string segments, optionally trimming each segment before presence checks. */
export function joinPresentTextSegments(
  segments: ReadonlyArray<string | null | undefined>,
  options?: {
    trim?: boolean;
  },
): string | undefined {
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
  return values.length > 0 ? values.join("\n\n") : undefined;
}
