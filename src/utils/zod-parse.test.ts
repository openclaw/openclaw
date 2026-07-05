// Covers safeParseWithSchema and safeParseJsonWithSchema boundary behavior for plugin and config boundaries.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

const NameSchema = z.object({ name: z.string() });
const NumbersSchema = z.array(z.number());
const StringSchema = z.string();
const NestedSchema = z.object({
  user: z.object({ id: z.number(), email: z.string().email().optional() }),
});

describe("safeParseWithSchema", () => {
  it("returns parsed data for schema-valid objects", () => {
    expect(safeParseWithSchema(NameSchema, { name: "Ada" })).toEqual({ name: "Ada" });
  });

  it("returns null for schema-invalid values", () => {
    expect(safeParseWithSchema(NameSchema, { name: 1 })).toBeNull();
    expect(safeParseWithSchema(NameSchema, {})).toBeNull();
  });

  it("returns null for null and undefined input", () => {
    expect(safeParseWithSchema(NameSchema, null)).toBeNull();
    expect(safeParseWithSchema(NameSchema, undefined)).toBeNull();
  });

  it("works with array schemas", () => {
    expect(safeParseWithSchema(NumbersSchema, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(safeParseWithSchema(NumbersSchema, ["a"])).toBeNull();
  });

  it("works with primitive schemas", () => {
    expect(safeParseWithSchema(StringSchema, "hello")).toBe("hello");
    expect(safeParseWithSchema(StringSchema, 123)).toBeNull();
  });

  it("works with nested object schemas", () => {
    const valid = { user: { id: 1, email: "a@b.com" } };
    expect(safeParseWithSchema(NestedSchema, valid)).toEqual(valid);
  });

  it("returns null when nested fields fail validation", () => {
    expect(safeParseWithSchema(NestedSchema, { user: { id: "x" } })).toBeNull();
  });

  it("accepts objects with optional fields present or absent", () => {
    expect(safeParseWithSchema(NestedSchema, { user: { id: 1 } })).toEqual({
      user: { id: 1 },
    });
  });
});

describe("safeParseJsonWithSchema", () => {
  it("returns parsed data for valid JSON strings", () => {
    expect(safeParseJsonWithSchema(NameSchema, `{"name":"Ada"}`)).toEqual({
      name: "Ada",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(safeParseJsonWithSchema(NameSchema, "{")).toBeNull();
  });

  it("returns null for empty and whitespace-only strings", () => {
    expect(safeParseJsonWithSchema(NameSchema, "")).toBeNull();
    expect(safeParseJsonWithSchema(NameSchema, "   ")).toBeNull();
  });

  it("returns null when JSON parses but schema rejects", () => {
    expect(safeParseJsonWithSchema(NameSchema, `{"name":1}`)).toBeNull();
    expect(safeParseJsonWithSchema(NameSchema, `{}`)).toBeNull();
  });

  it("works with array JSON and array schemas", () => {
    expect(safeParseJsonWithSchema(NumbersSchema, `[1,2,3]`)).toEqual([1, 2, 3]);
    expect(safeParseJsonWithSchema(NumbersSchema, `["a"]`)).toBeNull();
  });

  it("returns null for valid JSON of the wrong type", () => {
    // Number JSON passed to an object schema — schema rejects
    expect(safeParseJsonWithSchema(NameSchema, `42`)).toBeNull();
    // null JSON — schema rejects because expected object
    expect(safeParseJsonWithSchema(NameSchema, `null`)).toBeNull();
  });
});
