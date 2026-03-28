/**
 * Split an array into fixed-size chunks.
 *
 * The last chunk may be smaller than `size` when items.length is not evenly
 * divisible.  When size <= 0, returns a single chunk containing all items.
 *
 * Uses Array.from({length, mapFn}) to pre-allocate and fill in one pass:
 *   chunkCount = ceil(n / size)   — number of output chunks
 *   rows[i]    = items.slice(i*size, (i+1)*size)  — O(1) index arithmetic
 * Overall: O(n) time, O(n) space — optimal for this operation.
 */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return [Array.from(items)];
  }
  const chunkCount = Math.ceil(items.length / size);
  // Array.from({length}, mapFn) is the project-preferred idiom (unicorn/no-new-array).
  // The map callback computes each slice index arithmetically — O(1) per chunk.
  return Array.from({ length: chunkCount }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}
