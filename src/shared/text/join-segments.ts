/** Concatenates two optional text blocks, preserving the right block's explicit empty string. */
export function concatOptionalTextSegments(params: {
  /** Existing left-hand text segment. */
  left?: string;
  /** Right-hand text segment to append or preserve as an explicit empty string. */
  right?: string;
  /** Separator inserted only when both segments are present. */
  separator?: string;
}): string | undefined {
  const separator = params.separator ?? "\n\n";
  if (params.left && params.right) {
    return `${params.left}${separator}${params.right}`;
  }
  return params.right ?? params.left;
}

/** Joins non-empty string segments, optionally trimming each segment before presence checks. */
export function joinPresentTextSegments(
  segments: ReadonlyArray<string | null | undefined>,
  options?: {
    /** Separator inserted between present segments. */
    separator?: string;
    /** Whether to trim before deciding if a segment is present. */
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
    // Store normalized values so trim=true affects both filtering and output text.
    values.push(normalized);
  }
  return values.length > 0 ? values.join(separator) : undefined;
}
