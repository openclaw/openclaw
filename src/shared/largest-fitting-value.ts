/** Search an inclusive integer interval; return min when no probed value fits. */
export function largestFittingValue(
  min: number,
  max: number,
  fits: (value: number) => boolean,
): number {
  let lo = min;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
