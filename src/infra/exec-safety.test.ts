import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "./exec-safety.js";

describe("isSafeExecutableValue", () => {
  it("accepts bare executable names and likely paths", () => {
    expect(isSafeExecutableValue("node")).toBe(true);
    expect(isSafeExecutableValue("/usr/bin/node")).toBe(true);
    expect(isSafeExecutableValue("./bin/openclaw")).toBe(true);
    expect(isSafeExecutableValue("C:\\Tools\\openclaw.exe")).toBe(true);
    expect(isSafeExecutableValue(" tool ")).toBe(true);
  });

  it("rejects blanks, flags, shell metacharacters, quotes, and control chars", () => {
    expect(isSafeExecutableValue(undefined)).toBe(false);
    expect(isSafeExecutableValue("   ")).toBe(false);
    expect(isSafeExecutableValue("-rf")).toBe(false);
    expect(isSafeExecutableValue("node;rm -rf /")).toBe(false);
    expect(isSafeExecutableValue('node "arg"')).toBe(false);
    expect(isSafeExecutableValue("node\nnext")).toBe(false);
    expect(isSafeExecutableValue("node\0")).toBe(false);
  });
});
