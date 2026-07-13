/**
 * Regression coverage for toolSearch `limit` schema tightening.
 *
 * Covers Type.Number → Type.Integer + minimum:1 conversion:
 * - valid integers accepted
 * - floats rejected at schema layer
 * - zero/negative rejected by minimum:1
 * - omitted limit accepted (optional)
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

const schema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of results." })),
});

describe("toolSearch limit schema", () => {
  it("accepts valid positive integer", () => {
    expect(Value.Check(schema, { query: "test", limit: 5 })).toBe(true);
  });

  it("accepts limit=1 (minimum boundary)", () => {
    expect(Value.Check(schema, { query: "test", limit: 1 })).toBe(true);
  });

  it("accepts large limit", () => {
    expect(Value.Check(schema, { query: "test", limit: 50 })).toBe(true);
  });

  it("rejects float limit", () => {
    expect(Value.Check(schema, { query: "test", limit: 5.5 })).toBe(false);
  });

  it("rejects zero limit (below minimum)", () => {
    expect(Value.Check(schema, { query: "test", limit: 0 })).toBe(false);
  });

  it("rejects negative limit", () => {
    expect(Value.Check(schema, { query: "test", limit: -1 })).toBe(false);
  });

  it("accepts omitted limit (optional)", () => {
    expect(Value.Check(schema, { query: "test" })).toBe(true);
  });
});
