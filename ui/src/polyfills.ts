/**
 * Polyfills for browsers that lack ES2023+ Array methods.
 * Fixes blank-page crash on older Chromium builds (e.g. Chrome < 110).
 * See: https://github.com/openclaw/openclaw/issues/30467
 */

/* eslint-disable @typescript-eslint/no-unnecessary-condition */

if (!Array.prototype.toSorted) {
  const nativeSort = Array.prototype.sort;
  // eslint-disable-next-line no-extend-native
  Array.prototype.toSorted = function <T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
    return nativeSort.call([...this], compareFn);
  };
}

if (!Array.prototype.toReversed) {
  const nativeReverse = Array.prototype.reverse;
  // eslint-disable-next-line no-extend-native
  Array.prototype.toReversed = function <T>(this: T[]): T[] {
    return nativeReverse.call([...this]);
  };
}
