import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

const stringSchema = z.string();
const objectSchema = z.object({ name: z.string(), age: z.number() });

describe("safeParseWithSchema", () => {
  it("returns the parsed value when the schema passes", () => {
    expect(safeParseWithSchema(stringSchema, "hello")).toBe("hello");
    expect(safeParseWithSchema(objectSchema, { name: "Alice", age: 30 })).toEqual({
      name: "Alice",
      age: 30,
    });
  });

  it("returns null when the schema fails", () => {
    expect(safeParseWithSchema(stringSchema, 123)).toBeNull();
    expect(safeParseWithSchema(objectSchema, { name: "Bob" })).toBeNull();
    expect(safeParseWithSchema(objectSchema, null)).toBeNull();
  });
});

describe("safeParseJsonWithSchema", () => {
  it("returns the parsed value for valid JSON passing the schema", () => {
    expect(safeParseJsonWithSchema(stringSchema, '"hello"')).toBe("hello");
    expect(safeParseJsonWithSchema(objectSchema, '{"name":"Alice","age":30}')).toEqual({
      name: "Alice",
      age: 30,
    });
  });

  it("returns null for valid JSON failing the schema", () => {
    expect(safeParseJsonWithSchema(stringSchema, "123")).toBeNull();
    expect(safeParseJsonWithSchema(objectSchema, '"not an object"')).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(safeParseJsonWithSchema(stringSchema, "{bad")).toBeNull();
    expect(safeParseJsonWithSchema(stringSchema, "")).toBeNull();
  });
});
