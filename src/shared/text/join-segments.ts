import {
  filterStringEntries,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";

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
  const values = options?.trim
    ? normalizeTrimmedStringList(segments)
    : filterStringEntries(segments).filter(Boolean);
  return values.join("\n\n") || undefined;
}
