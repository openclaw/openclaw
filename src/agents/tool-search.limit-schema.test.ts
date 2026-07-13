/**
 * Regression coverage for toolSearch `limit` schema tightening.
 *
 * Two validation layers:
 * 1. Schema layer: TypeBox Value.Check rejects float/zero/negative values.
 * 2. Execution layer: tool.execute() rejects non-integer limit at runtime
 *    via readSearchArgs → readLimit, covering the provider-normalization
 *    path where schema constraints may be stripped.
 *
 * Covers Type.Integer({ minimum: 1 }) conversion:
 * - valid positive integers accepted
 * - floats rejected at schema layer and execution boundary
 * - zero/negative rejected by minimum:1
 * - omitted limit accepted (optional)
 */
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createToolSearchTools, TOOL_SEARCH_RAW_TOOL_NAME } from "./tool-search.js";

// Minimal context: only what's needed for schema availability.
// Runtime execution (ToolSearchRuntime) is not exercised for schema tests.
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

describe("toolSearch limit execution boundary", () => {
  it("rejects float limit at runtime", async () => {
    await expect(searchTool.execute("call-1", { query: "test", limit: 5.5 })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it("rejects zero limit at runtime", async () => {
    await expect(searchTool.execute("call-1", { query: "test", limit: 0 })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it("rejects negative limit at runtime", async () => {
    await expect(searchTool.execute("call-1", { query: "test", limit: -1 })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });
});
