/**
 * Polyfills for older browsers that lack newer Array/TypedArray methods.
 * Must be imported before any application code.
 */

if (!Array.prototype.toSorted) {
  // eslint-disable-next-line no-extend-native
  Array.prototype.toSorted = function <T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
    // oxlint-disable-next-line unicorn/prefer-array-flat-map
    const copy = this.slice();
    copy.sort(compareFn); // oxlint-ignore unicorn/require-array-sort-compare
    return copy;
  };
}
