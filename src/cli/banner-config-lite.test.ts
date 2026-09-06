// Tests for lightweight banner tagline mode parser.
import { describe, expect, it } from "vitest";
import { parseTaglineMode } from "./banner-config-lite.js";

describe("parseTaglineMode", () => {
  it.each([
    { value: "random", expected: "random", reason: "random mode" },
    { value: "default", expected: "default", reason: "default mode" },
    { value: "off", expected: "off", reason: "off mode" },
  ])("returns '$expected' for '$value' ($reason)", ({ value, expected }) => {
    expect(parseTaglineMode(value)).toBe(expected);
  });

  it.each([
    { value: undefined, reason: "undefined" },
    { value: null, reason: "null" },
    { value: "", reason: "empty string" },
    { value: "invalid", reason: "invalid string" },
    { value: "RANDOM", reason: "uppercase random" },
    { value: "Random", reason: "mixed case random" },
    { value: 123, reason: "number" },
    { value: true, reason: "boolean" },
    { value: {}, reason: "object" },
    { value: [], reason: "array" },
  ])("returns undefined for '$value' ($reason)", ({ value }) => {
    expect(parseTaglineMode(value)).toBeUndefined();
  });
});
