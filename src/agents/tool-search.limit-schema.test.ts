/**
 * Regression coverage for toolSearch `limit` schema tightening.
 *
 * Validates against the actual production `tool_search` parameter schema
 * from `createToolSearchTools`, not a standalone copy.
 *
 * Covers Type.Integer({ minimum: 1 }) conversion:
 * - valid positive integers accepted
 * - floats rejected at schema layer
 * - zero/negative rejected by minimum:1
 * - omitted limit accepted (optional)
 */
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createToolSearchTools, TOOL_SEARCH_RAW_TOOL_NAME } from "./tool-search.js";

// Minimal context: only what's needed for schema availability.
// Runtime execution (ToolSearchRuntime) is not exercised.
const tools = createToolSearchTools({} as any);
const searchTool = tools.find((t) => t.name === TOOL_SEARCH_RAW_TOOL_NAME)!;
const schema = searchTool.parameters;

describe("toolSearch limit schema (production)", () => {
  it("accepts valid positive integer limit", () => {
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

  it("rejects missing required query", () => {
    expect(Value.Check(schema, { limit: 5 })).toBe(false);
  });
});
