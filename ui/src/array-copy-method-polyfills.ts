// Control UI module installs array copy method fallbacks for older browsers.

export function installArrayCopyMethodPolyfills(): void {
  const proto = Array.prototype as unknown as Record<string, unknown>;

  if (typeof proto.toSorted !== "function") {
    // oxlint-disable-next-line eslint/no-extend-native -- entrypoint polyfill for legacy browsers.
    Object.defineProperty(Array.prototype, "toSorted", {
      configurable: true,
      writable: true,
      value: function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
        const copy = this.slice();
        // oxlint-disable-next-line unicorn/no-array-sort -- fallback for browsers without toSorted.
        copy.sort(compareFn);
        return copy;
      },
    });
  }

  if (typeof proto.toReversed !== "function") {
    // oxlint-disable-next-line eslint/no-extend-native -- entrypoint polyfill for legacy browsers.
    Object.defineProperty(Array.prototype, "toReversed", {
      configurable: true,
      writable: true,
      value: function toReversed<T>(this: T[]): T[] {
        const copy = this.slice();
        // oxlint-disable-next-line unicorn/no-array-reverse -- fallback for browsers without toReversed.
        return copy.reverse();
      },
    });
  }
}

installArrayCopyMethodPolyfills();
