// Parse JSON compat tests cover strict-then-JSON5 fallback parsing.
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJsonWithJson5Fallback } from "./parse-json-compat.js";

describe("parseJsonWithJson5Fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses strict JSON via JSON.parse without invoking JSON5", () => {
    const jsonParseSpy = vi.spyOn(JSON, "parse");
    const json5ParseSpy = vi.spyOn(JSON5, "parse");

    expect(parseJsonWithJson5Fallback('{"a":1}')).toEqual({ a: 1 });
    expect(jsonParseSpy).toHaveBeenCalled();
    expect(json5ParseSpy).not.toHaveBeenCalled();
  });

  it("falls back to JSON5 when JSON.parse throws", () => {
    const json5ParseSpy = vi.spyOn(JSON5, "parse");

    expect(parseJsonWithJson5Fallback('{"a":1,}')).toEqual({ a: 1 });
    expect(json5ParseSpy).toHaveBeenCalled();
  });

  it("throws when both JSON and JSON5 parsing fail", () => {
    expect(() => parseJsonWithJson5Fallback("{invalid")).toThrow();
  });
});
