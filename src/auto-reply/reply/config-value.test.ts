import { describe, expect, it } from "vitest";
import { parseConfigValue } from "./config-value.js";

describe("parseConfigValue", () => {
  it("parses booleans", () => {
    expect(parseConfigValue("true")).toEqual({ value: true });
    expect(parseConfigValue("false")).toEqual({ value: false });
  });

  it("parses null", () => {
    expect(parseConfigValue("null")).toEqual({ value: null });
  });

  it("parses integers", () => {
    expect(parseConfigValue("42")).toEqual({ value: 42 });
    expect(parseConfigValue("-7")).toEqual({ value: -7 });
  });

  it("parses floats", () => {
    expect(parseConfigValue("3.14")).toEqual({ value: 3.14 });
  });

  it("parses scientific notation as a number", () => {
    expect(parseConfigValue("1e5")).toEqual({ value: 100000 });
    expect(parseConfigValue("2.5e10")).toEqual({ value: 25000000000 });
    expect(parseConfigValue("1E3")).toEqual({ value: 1000 });
    expect(parseConfigValue("1e-2")).toEqual({ value: 0.01 });
  });

  it("parses JSON objects and arrays", () => {
    expect(parseConfigValue('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseConfigValue("[1,2,3]")).toEqual({ value: [1, 2, 3] });
  });

  it("parses quoted strings", () => {
    expect(parseConfigValue('"hello"')).toEqual({ value: "hello" });
    expect(parseConfigValue("'world'")).toEqual({ value: "world" });
  });

  it("returns plain string for unrecognized values", () => {
    expect(parseConfigValue("hello")).toEqual({ value: "hello" });
  });

  it("returns error for empty input", () => {
    expect(parseConfigValue("   ")).toEqual({ error: "Missing value." });
  });

  it("returns error for invalid JSON", () => {
    expect(parseConfigValue("{bad}")).toHaveProperty("error");
  });
});
