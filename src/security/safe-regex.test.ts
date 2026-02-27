import { describe, expect, it } from "vitest";
import { compileSafeRegex, hasNestedRepetition } from "./safe-regex.js";

describe("safe regex", () => {
  it("flags nested repetition patterns", () => {
    expect(hasNestedRepetition("(a+)+$")).toBe(true);
    expect(hasNestedRepetition("^(?:foo|bar)$")).toBe(false);
  });

  it("rejects unsafe nested repetition during compile", () => {
    expect(compileSafeRegex("(a+)+$")).toBeNull();
  });

  it("compiles common safe filter regex", () => {
    const re = compileSafeRegex("^agent:.*:discord:");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test("agent:main:discord:channel:123")).toBe(true);
    expect(re?.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = compileSafeRegex("token=([A-Za-z0-9]+)", "gi");
    expect(re).toBeInstanceOf(RegExp);
    expect("TOKEN=abcd1234".replace(re as RegExp, "***")).toBe("***");
  });
});
