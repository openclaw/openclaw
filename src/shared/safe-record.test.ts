// Defensive safe-record tests cover isRecord, readRecordValue, copyArrayEntries, copyRecordEntries.
import { describe, expect, it } from "vitest";
import { isRecord, readRecordValue, copyArrayEntries, copyRecordEntries } from "./safe-record.js";

describe("shared/safe-record", () => {
  describe("isRecord", () => {
    it("returns true for plain objects", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
    });

    it("returns false for null and undefined", () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2, 3])).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isRecord("string")).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(Symbol("test"))).toBe(false);
    });

    it("returns false for functions", () => {
      expect(isRecord(() => undefined)).toBe(false);
    });

    it("does not throw on values with hostile toString or getters", () => {
      const hostile = Object.create(null);
      Object.defineProperty(hostile, "trap", {
        get() {
          throw new Error("boo");
        },
      });
      expect(isRecord(hostile)).toBe(true);
    });
  });

  describe("readRecordValue", () => {
    it("reads an existing key", () => {
      expect(readRecordValue({ a: 1, b: "hello" }, "a")).toBe(1);
      expect(readRecordValue({ a: 1, b: "hello" }, "b")).toBe("hello");
    });

    it("returns undefined for missing key", () => {
      expect(readRecordValue({ a: 1 }, "nonexistent")).toBeUndefined();
    });

    it("returns undefined for non-record values", () => {
      expect(readRecordValue(null, "a")).toBeUndefined();
      expect(readRecordValue([], "length")).toBeUndefined();
      expect(readRecordValue("string", "length")).toBeUndefined();
    });

    it("does not throw on getter that throws", () => {
      const hostile = {
        get safe() {
          return 1;
        },
        get trap() {
          throw new Error("boo");
        },
      };
      expect(readRecordValue(hostile, "safe")).toBe(1);
      expect(readRecordValue(hostile, "trap")).toBeUndefined();
    });
  });

  describe("copyArrayEntries", () => {
    it("copies entries from a normal array", () => {
      expect(copyArrayEntries([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("returns empty array for empty input", () => {
      expect(copyArrayEntries([])).toEqual([]);
    });

    it("returns empty array for non-array values", () => {
      expect(copyArrayEntries(null)).toEqual([]);
      expect(copyArrayEntries({})).toEqual([]);
      expect(copyArrayEntries("string")).toEqual([]);
      expect(copyArrayEntries(42)).toEqual([]);
    });

    it("preserves sparse array entries", () => {
      const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
      expect(copyArrayEntries(sparse)).toEqual([1, undefined, 3]);
    });

    it("handles array with hostile length getter", () => {
      const hostile = new Proxy([], {
        get(target, prop) {
          if (prop === "length") {
            throw new Error("boo");
          }
          return Reflect.get(target, prop);
        },
      });
      expect(copyArrayEntries(hostile)).toEqual([]);
    });

    it("skips entries whose index accessor throws", () => {
      const hostile: unknown[] = [1, 2, 3];
      Object.defineProperty(hostile, 1, {
        get() {
          throw new Error("boo");
        },
      });
      expect(copyArrayEntries(hostile)).toEqual([1, 3]);
    });

    it("copies array-like but not actual array as empty", () => {
      const arrayLike = { 0: "a", 1: "b", length: 2 };
      expect(copyArrayEntries(arrayLike)).toEqual([]);
    });
  });

  describe("copyRecordEntries", () => {
    it("copies entries from a normal record", () => {
      expect(copyRecordEntries({ a: { x: 1 }, b: { y: 2 } })).toEqual([
        ["a", { x: 1 }],
        ["b", { y: 2 }],
      ]);
    });

    it("filters out non-record values", () => {
      const result = copyRecordEntries({
        a: { x: 1 },
        b: "string",
        c: 42,
        d: null,
        e: [1, 2, 3],
      });
      expect(result).toEqual([["a", { x: 1 }]]);
    });

    it("returns empty array for non-record input", () => {
      expect(copyRecordEntries(null)).toEqual([]);
      expect(copyRecordEntries(undefined)).toEqual([]);
      expect(copyRecordEntries([])).toEqual([]);
      expect(copyRecordEntries("string")).toEqual([]);
    });

    it("returns empty array for empty object", () => {
      expect(copyRecordEntries({})).toEqual([]);
    });

    it("does not throw on Object.keys that throws", () => {
      const hostile = Object.create(null);
      Object.defineProperty(hostile, "trap", {
        get() {
          throw new Error("boo");
        },
      });
      // The object still has keys.
      const result = copyRecordEntries(hostile);
      // The trap key is not a record value, so it gets filtered out.
      expect(result).toEqual([]);
    });
  });
});
