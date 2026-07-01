// Zod parse tests cover null-returning schema validation helpers.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

const NameSchema = z.object({ name: z.string() });

describe("safeParseWithSchema", () => {
  it("returns parsed data when validation succeeds", () => {
    expect(safeParseWithSchema(z.string(), "hello")).toBe("hello");
    expect(safeParseWithSchema(NameSchema, { name: "test" })).toEqual({
      name: "test",
    });
  });

  it("returns null when validation fails", () => {
    expect(safeParseWithSchema(z.string(), 123)).toBeNull();
    expect(safeParseWithSchema(NameSchema, { name: 42 })).toBeNull();
    expect(safeParseWithSchema(NameSchema, {})).toBeNull();
  });
});

describe("safeParseJsonWithSchema", () => {
  it("parses valid JSON and validates against schema", () => {
    expect(safeParseJsonWithSchema(NameSchema, '{"name":"test"}')).toEqual({
      name: "test",
    });
    expect(safeParseJsonWithSchema(z.array(z.number()), "[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null for malformed JSON", () => {
    expect(safeParseJsonWithSchema(NameSchema, "{bad")).toBeNull();
    expect(safeParseJsonWithSchema(NameSchema, "")).toBeNull();
  });

  it("returns null when JSON is valid but schema rejects", () => {
    expect(safeParseJsonWithSchema(NameSchema, "{}")).toBeNull();
    expect(safeParseJsonWithSchema(NameSchema, '{"name":42}')).toBeNull();
  });
});
