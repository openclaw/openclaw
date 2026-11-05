import { describe, expect, it } from "vitest";
import { normalizeOptionalTrimmedStringRecord } from "./collection-input.js";

describe("collection input", () => {
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
