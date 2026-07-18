import { describe, expect, it } from "vitest";
import {
  copyArrayEntries,
  copyRecordEntries,
  isRecordWithoutThrowing,
  readRecordValue,
} from "./safe-record.js";

describe("isRecordWithoutThrowing", () => {
  it("returns true for plain objects", () => {
    expect(isRecordWithoutThrowing({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isRecordWithoutThrowing(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRecordWithoutThrowing(undefined)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isRecordWithoutThrowing([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRecordWithoutThrowing("string")).toBe(false);
    expect(isRecordWithoutThrowing(42)).toBe(false);
    expect(isRecordWithoutThrowing(true)).toBe(false);
  });

  it("survives a throwing Proxy", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(isRecordWithoutThrowing(hostile)).toBe(false);
  });
});

describe("readRecordValue", () => {
  it("reads an existing property", () => {
    expect(readRecordValue({ name: "test" }, "name")).toBe("test");
  });

  it("returns undefined for missing property", () => {
    expect(readRecordValue({ name: "test" }, "missing")).toBeUndefined();
  });

  it("returns undefined for non-record input", () => {
    expect(readRecordValue(null, "key")).toBeUndefined();
    expect(readRecordValue("string", "key")).toBeUndefined();
  });
});

describe("copyArrayEntries", () => {
  it("copies array elements", () => {
    expect(copyArrayEntries([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("returns empty array for non-array", () => {
    expect(copyArrayEntries("string")).toEqual([]);
    expect(copyArrayEntries(null)).toEqual([]);
  });

  it("handles empty array", () => {
    expect(copyArrayEntries([])).toEqual([]);
  });
});

describe("copyRecordEntries", () => {
  it("copies nested record entries", () => {
    const entries = copyRecordEntries({ a: { v: 1 }, b: { v: 2 } });
    expect(entries).toHaveLength(2);
  });

  it("skips non-record values", () => {
    const entries = copyRecordEntries({ a: { v: 1 }, b: "string", c: 42 });
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for non-record input", () => {
    expect(copyRecordEntries(null)).toEqual([]);
    expect(copyRecordEntries("string")).toEqual([]);
  });
});
