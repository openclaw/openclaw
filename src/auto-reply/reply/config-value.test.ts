import { describe, expect, it } from "vitest";
import { parseConfigValue } from "./config-value.js";

describe("parseConfigValue", () => {
  it("returns error for empty string", () => {
    expect(parseConfigValue("")).toEqual({ error: "Missing value." });
    expect(parseConfigValue("   ")).toEqual({ error: "Missing value." });
  });

  it("parses true/false/null", () => {
    expect(parseConfigValue("true")).toEqual({ value: true });
    expect(parseConfigValue("false")).toEqual({ value: false });
    expect(parseConfigValue("null")).toEqual({ value: null });
  });

  it("parses integers", () => {
    expect(parseConfigValue("42")).toEqual({ value: 42 });
    expect(parseConfigValue("-7")).toEqual({ value: -7 });
    expect(parseConfigValue("0")).toEqual({ value: 0 });
  });

  it("parses floats", () => {
    expect(parseConfigValue("3.14")).toEqual({ value: 3.14 });
    expect(parseConfigValue("-0.5")).toEqual({ value: -0.5 });
  });

  it("parses JSON objects", () => {
    expect(parseConfigValue('{"a":1}')).toEqual({ value: { a: 1 } });
  });

  it("parses JSON arrays", () => {
    expect(parseConfigValue("[1,2,3]")).toEqual({ value: [1, 2, 3] });
  });

  it("returns error for invalid JSON objects", () => {
    const result = parseConfigValue("{bad}");
    expect(result.error).toContain("Invalid JSON");
  });

  it("strips double quotes", () => {
    expect(parseConfigValue('"hello"')).toEqual({ value: "hello" });
  });

  it("strips single quotes", () => {
    expect(parseConfigValue("'world'")).toEqual({ value: "world" });
  });

  it("returns plain string as-is", () => {
    expect(parseConfigValue("some text")).toEqual({ value: "some text" });
  });

  it("trims whitespace", () => {
    expect(parseConfigValue("  42  ")).toEqual({ value: 42 });
    expect(parseConfigValue("  hello  ")).toEqual({ value: "hello" });
  });
});
