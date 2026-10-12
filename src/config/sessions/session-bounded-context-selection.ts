/** The newest contiguous eligible rows must fit together with the canonical header. */
export function selectBoundedContextRows<T extends { serialized_bytes: number }>(
  rows: Iterable<T>,
  headerBytes: number,
  limits: { maxBytes: number; maxEvents: number },
): { selectedRows: T[]; serializedBytes: number; truncated: boolean } {
  if (headerBytes > limits.maxBytes) {
    throw new RangeError("Session transcript header exceeds the active-context byte limit");
  }
  const selectedRows: T[] = [];
  let serializedBytes = headerBytes;
  let truncated = false;
  for (const row of rows) {
    if (
      selectedRows.length >= limits.maxEvents ||
      serializedBytes + row.serialized_bytes > limits.maxBytes
    ) {
      truncated = true;
      break;
    }
    selectedRows.push(row);
    serializedBytes += row.serialized_bytes;
  }
  return { selectedRows, serializedBytes, truncated };
}
