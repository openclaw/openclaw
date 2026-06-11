type ArrayPrototypeCompat = Array<unknown> & {
  at?: <T>(this: T[], index: number) => T | undefined;
  toReversed?: <T>(this: T[]) => T[];
  toSorted?: <T>(this: T[], compareFn?: (a: T, b: T) => number) => T[];
  toSpliced?: <T>(this: T[], start: number, deleteCount?: number, ...items: T[]) => T[];
};

type ObjectConstructorCompat = ObjectConstructor & {
  hasOwn?: (object: object, key: PropertyKey) => boolean;
};

type StringPrototypeCompat = {
  replaceAll?: (searchValue: string | RegExp, replaceValue: string) => string;
};

function defineCompatValue(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function installBrowserCompatPolyfills(globalObject: typeof globalThis = globalThis): void {
  const arrayPrototype = globalObject.Array.prototype as ArrayPrototypeCompat;
  const stringPrototype = globalObject.String.prototype as StringPrototypeCompat;
  const objectConstructor = globalObject.Object as ObjectConstructorCompat;

  if (typeof arrayPrototype.at !== "function") {
    defineCompatValue(arrayPrototype, "at", function arrayAtCompat<T>(this: T[], index: number):
      | T
      | undefined {
      const relativeIndex = Math.trunc(index) || 0;
      const resolvedIndex = relativeIndex >= 0 ? relativeIndex : this.length + relativeIndex;
      return resolvedIndex < 0 || resolvedIndex >= this.length ? undefined : this[resolvedIndex];
    });
  }

  if (typeof arrayPrototype.toSorted !== "function") {
    defineCompatValue(arrayPrototype, "toSorted", function toSortedCompat<
      T,
    >(this: T[], compareFn?: (a: T, b: T) => number): T[] {
      const next = [...this];
      next.sort(compareFn);
      return next;
    });
  }

  if (typeof arrayPrototype.toReversed !== "function") {
    defineCompatValue(arrayPrototype, "toReversed", function toReversedCompat<T>(this: T[]): T[] {
      const next = [...this];
      next.reverse();
      return next;
    });
  }

  if (typeof arrayPrototype.toSpliced !== "function") {
    defineCompatValue(arrayPrototype, "toSpliced", function toSplicedCompat<
      T,
    >(this: T[], start: number, deleteCount?: number, ...items: T[]): T[] {
      const next = [...this];
      if (arguments.length === 1) {
        next.splice(start);
      } else {
        next.splice(start, deleteCount === undefined ? 0 : deleteCount, ...items);
      }
      return next;
    });
  }

  if (typeof globalObject.structuredClone !== "function") {
    defineCompatValue(globalObject, "structuredClone", function structuredCloneCompat<
      T,
    >(value: T): T {
      if (value === null || typeof value !== "object") {
        return value;
      }
      return JSON.parse(JSON.stringify(value)) as T;
    });
  }

  if (typeof objectConstructor.hasOwn !== "function") {
    defineCompatValue(
      objectConstructor,
      "hasOwn",
      function objectHasOwnCompat(object: object, key: PropertyKey): boolean {
        return Object.prototype.hasOwnProperty.call(object, key);
      },
    );
  }

  if (typeof stringPrototype.replaceAll !== "function") {
    defineCompatValue(
      stringPrototype,
      "replaceAll",
      function replaceAllCompat(
        this: string,
        searchValue: string | RegExp,
        replaceValue: string,
      ): string {
        if (searchValue instanceof RegExp) {
          if (!searchValue.global) {
            throw new TypeError("String.prototype.replaceAll called with a non-global RegExp");
          }
          return this.replace(searchValue, replaceValue);
        }
        return this.replace(new RegExp(escapeRegExp(searchValue), "g"), replaceValue);
      },
    );
  }
}

installBrowserCompatPolyfills();
