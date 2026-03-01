// Polyfill Array.prototype.toSorted for browsers that lack it (e.g. Chrome < 110).
if (!Array.prototype.toSorted) {
  // eslint-disable-next-line no-extend-native
  Array.prototype.toSorted = function <T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
    // oxlint-disable-next-line unicorn/no-array-sort -- polyfill must use sort()
    return [...this].sort(compareFn);
  };
}
