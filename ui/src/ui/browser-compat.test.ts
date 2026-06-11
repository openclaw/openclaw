import { describe, expect, it } from "vitest";
import { installBrowserCompatPolyfills } from "./browser-compat.ts";

type ArrayCompatKey = "at" | "toSorted" | "toReversed" | "toSpliced";

function withMissingArrayMethod(key: ArrayCompatKey, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
  try {
    // eslint-disable-next-line no-extend-native -- Test temporarily removes native methods to verify the compat installer.
    Object.defineProperty(Array.prototype, key, {
      configurable: true,
      writable: true,
      value: undefined,
    });
    run();
  } finally {
    if (descriptor) {
      // eslint-disable-next-line no-extend-native -- Restore the native method after the compat test.
      Object.defineProperty(Array.prototype, key, descriptor);
    } else {
      Reflect.deleteProperty(Array.prototype, key);
    }
  }
}

describe("installBrowserCompatPolyfills", () => {
  it("installs Array.at with negative index support", () => {
    withMissingArrayMethod("at", () => {
      installBrowserCompatPolyfills();

      expect(["a", "b", "c"].at(-1)).toBe("c");
      expect(["a", "b", "c"].at(10)).toBeUndefined();
    });
  });

  it("installs toSorted without mutating the source array", () => {
    withMissingArrayMethod("toSorted", () => {
      installBrowserCompatPolyfills();

      const values = [3, 1, 2];
      expect(values.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(values).toEqual([3, 1, 2]);
    });
  });

  it("installs toReversed without mutating the source array", () => {
    withMissingArrayMethod("toReversed", () => {
      installBrowserCompatPolyfills();

      const values = ["a", "b", "c"];
      expect(values.toReversed()).toEqual(["c", "b", "a"]);
      expect(values).toEqual(["a", "b", "c"]);
    });
  });

  it("installs toSpliced without mutating the source array", () => {
    withMissingArrayMethod("toSpliced", () => {
      installBrowserCompatPolyfills();

      const values = ["a", "b", "c"];
      expect(values.toSpliced(1, 1, "x")).toEqual(["a", "x", "c"]);
      expect(values.toSpliced(1, undefined as unknown as number, "x")).toEqual([
        "a",
        "x",
        "b",
        "c",
      ]);
      expect(values).toEqual(["a", "b", "c"]);
    });
  });

  it("installs a structuredClone fallback for JSON-compatible state", () => {
    const fakeGlobal = {
      Array,
      Object,
      String,
      structuredClone: undefined,
    } as unknown as typeof globalThis;

    installBrowserCompatPolyfills(fakeGlobal);

    const original = { nested: { count: 1 } };
    const cloned = fakeGlobal.structuredClone(original);
    cloned.nested.count = 2;

    expect(original.nested.count).toBe(1);
    expect(cloned).toEqual({ nested: { count: 2 } });
  });

  it("installs Object.hasOwn", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object, "hasOwn");
    try {
      Object.defineProperty(Object, "hasOwn", {
        configurable: true,
        writable: true,
        value: undefined,
      });

      installBrowserCompatPolyfills();

      expect(Object.hasOwn({ a: 1 }, "a")).toBe(true);
      expect(Object.hasOwn({ a: 1 }, "b")).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(Object, "hasOwn", descriptor);
      } else {
        Reflect.deleteProperty(Object, "hasOwn");
      }
    }
  });

  it("installs String.replaceAll for string and global regex search values", () => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "replaceAll");
    try {
      // eslint-disable-next-line no-extend-native -- Test temporarily removes native replaceAll to verify the compat installer.
      Object.defineProperty(String.prototype, "replaceAll", {
        configurable: true,
        writable: true,
        value: undefined,
      });

      installBrowserCompatPolyfills();

      expect("a*b*a".replaceAll("*", "-")).toBe("a-b-a");
      expect("aba".replaceAll(/a/g, "x")).toBe("xbx");
      const nonGlobalSearch = /a/;
      // eslint-disable-next-line oxc/bad-replace-all-arg -- Compat test verifies the required TypeError for non-global RegExp input.
      expect(() => "aba".replaceAll(nonGlobalSearch, "x")).toThrow(TypeError);
    } finally {
      if (descriptor) {
        // eslint-disable-next-line no-extend-native -- Restore the native method after the compat test.
        Object.defineProperty(String.prototype, "replaceAll", descriptor);
      } else {
        Reflect.deleteProperty(String.prototype, "replaceAll");
      }
    }
  });
});
