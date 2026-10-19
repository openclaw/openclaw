import { ensureRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { isStringArray, normalizeOptionalTrimmedStringRecord } from "./collection-input.js";

describe("collection input", () => {
  it.each([
    [[], true],
    [["", " padded "], true],
    [Array<string>(2), true],
    [["ok", 1], false],
    [{ 0: "ok", length: 1 }, false],
    [null, false],
  ])("admits string arrays without coercion or density rules: %j", (value, expected) => {
    expect(isStringArray(value)).toBe(expected);
  });

  it("retains existing records without assigning to their parent", () => {
    const record = { value: 1 };
    expect(ensureRecord(Object.freeze({ nested: record }), "nested")).toBe(record);
    const instance = new Date(0);
    expect(ensureRecord({ nested: instance }, "nested")).toBe(instance);
    expect(ensureRecord({}, "__proto__")).toBe(Object.prototype);
  });

  it.each([undefined, null, [], 1, "value"])("replaces non-record values: %j", (value) => {
    const root = { nested: value };
    const record = ensureRecord(root, "nested");
    expect(record).toEqual({});
    expect(root.nested).toBe(record);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(ensureRecord({}, "nested")).not.toBe(record);
  });

  it("normalizes own string values without changing keys or assignment semantics", () => {
    const record = Object.assign(Object.create({ inherited: "ignored" }), {
      " padded key ": " value ",
      blank: " \t ",
      number: 3,
    });
    expect(normalizeOptionalTrimmedStringRecord(record)).toEqual({ " padded key ": "value" });
    const special = normalizeOptionalTrimmedStringRecord(
      JSON.parse('{"__proto__":" value ","constructor":" kept "}'),
    );
    expect(special).toEqual({ constructor: "kept" });
    expect(Object.getPrototypeOf(special)).toBe(Object.prototype);
    expect(normalizeOptionalTrimmedStringRecord({ blank: " ", number: 3 })).toBeUndefined();
    expect(
      normalizeOptionalTrimmedStringRecord(JSON.parse('{"__proto__":" value "}')),
    ).toBeUndefined();
  });
});
