// Control UI module installs array copy method fallbacks for older browsers.

const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
const arraySort = Array.prototype.sort;
const arrayReverse = Array.prototype.reverse;

export function installArrayCopyMethodPolyfills(): void {
  if (typeof arrayPrototype.toSorted !== "function") {
    Object.defineProperty(arrayPrototype, "toSorted", {
      configurable: true,
      writable: true,
      value: function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
        const copy = this.slice();
        arraySort.call(copy, compareFn);
        return copy;
      },
    });
  }

  if (typeof arrayPrototype.toReversed !== "function") {
    Object.defineProperty(arrayPrototype, "toReversed", {
      configurable: true,
      writable: true,
      value: function toReversed<T>(this: T[]): T[] {
        const copy = this.slice();
        return arrayReverse.call(copy) as T[];
      },
    });
  }
}

installArrayCopyMethodPolyfills();
