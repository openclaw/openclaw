// Control UI module installs minimal Array.prototype / Object.hasOwn
// polyfills for older browsers.
//
// `Array.prototype.toSorted`, `toReversed`, `toSpliced`, `with`,
// `findLast`, and `findLastIndex` were added to the ECMAScript spec in
// ES2023 and are unavailable in browsers older than Chrome 110 / Safari
// 16.4 / Firefox 115. The dashboard must keep working for users on
// Windows 7-era Chrome (see #98158) and other long-tail browsers, so
// install minimal fallbacks that delegate to existing stable methods.
// The original arrays are never mutated.
//
// `Object.hasOwn` (ES2022) is also patched for the same reason.
//
// This module is imported once from `src/main.ts` and runs at module
// evaluation time. It is intentionally written without TypeScript-only
// features so the transpiled output stays small and the polyfills are
// applied before the first user-visible render.

type Comparator<T> = (a: T, b: T) => number;

function installArrayMethod<K extends "toSorted" | "toReversed" | "toSpliced">(
  name: K,
  build: (self: unknown[], args: unknown[]) => unknown[],
): void {
  const proto = Array.prototype as unknown as Record<string, unknown>;
  if (typeof proto[name] === "function") return;
  Object.defineProperty(Array.prototype, name, {
    configurable: true,
    writable: true,
    value: function (this: unknown[], ...args: unknown[]): unknown[] {
      return build(this, args);
    },
  });
}

installArrayMethod("toSorted", (self, args) => {
  const compare = args[0] as Comparator<unknown> | undefined;
  const copy: unknown[] = self.slice();
  // `Array.prototype.sort` is stable in V8, JavaScriptCore, and SpiderMonkey
  // (ES2019+), so a copy + sort() preserves the same ordering as the
  // native toSorted() would produce.
  copy.sort(compare);
  return copy;
});

installArrayMethod("toReversed", (self) => self.slice().reverse());

installArrayMethod("toSpliced", (self, args) => {
  const startRaw = args[0];
  const deleteCountRaw = args[1];
  const items = args.slice(2) as unknown[];
  const start: number = Number.isFinite(startRaw) ? (startRaw as number) : 0;
  const deleteCount: number = Number.isFinite(deleteCountRaw) ? (deleteCountRaw as number) : 0;
  const copy = self.slice();
  copy.splice(start, deleteCount, ...items);
  return copy;
});

const arrayProto = Array.prototype as unknown as Record<string, unknown>;

if (typeof arrayProto["with"] !== "function") {
  Object.defineProperty(Array.prototype, "with", {
    configurable: true,
    writable: true,
    value: function <T>(this: T[], index: number, value: T): T[] {
      const len = this.length;
      const relativeIndex = index < 0 ? Math.max(len + index, 0) : index;
      if (relativeIndex >= len) {
        throw new RangeError(`Index ${index} out of range for length ${len}`);
      }
      const copy = this.slice() as T[];
      copy[relativeIndex] = value;
      return copy;
    },
  });
}

if (typeof arrayProto["findLast"] !== "function") {
  Object.defineProperty(Array.prototype, "findLast", {
    configurable: true,
    writable: true,
    value: function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
    ): T | undefined {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate(this[i] as T, i, this)) return this[i] as T;
      }
      return undefined;
    },
  });
}

if (typeof arrayProto["findLastIndex"] !== "function") {
  Object.defineProperty(Array.prototype, "findLastIndex", {
    configurable: true,
    writable: true,
    value: function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
    ): number {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate(this[i] as T, i, this)) return i;
      }
      return -1;
    },
  });
}

if (typeof (Object as unknown as Record<string, unknown>)["hasOwn"] !== "function") {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: function (obj: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(obj, key);
    },
  });
}
