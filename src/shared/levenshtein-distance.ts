export function levenshteinDistance(left: string, right: string): number;
export function levenshteinDistance(
  left: string,
  right: string,
  maxDistance: number,
): number | null;
export function levenshteinDistance(
  left: string,
  right: string,
  maxDistance?: number,
): number | null {
  if (left === right) {
    return 0;
  }
  if (!left || !right) {
    return maxDistance === undefined ? left.length + right.length : null;
  }
  if (maxDistance !== undefined && Math.abs(left.length - right.length) > maxDistance) {
    return null;
  }

  const row = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    row[index] = index;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = leftIndex;
    let current = leftIndex + 1;
    row[0] = current;
    let rowMin = leftIndex + 1;
    const leftCode = left.charCodeAt(leftIndex);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = leftCode === right.charCodeAt(rightIndex) ? 0 : 1;
      // The index is within the initialized row; save the next diagonal before overwrite.
      const above = row[rightIndex + 1]!;
      current = Math.min(current + 1, above + 1, diagonal + cost);
      row[rightIndex + 1] = current;
      rowMin = Math.min(rowMin, current);
      diagonal = above;
    }
    if (maxDistance !== undefined && rowMin > maxDistance) {
      return null;
    }
  }
  const distance = row[right.length]!;
  return maxDistance !== undefined && distance > maxDistance ? null : distance;
}
