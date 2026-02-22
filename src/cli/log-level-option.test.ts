import { describe, expect, it } from "vitest";
import { parseCliLogLevelOption } from "./log-level-option.js";

describe("parseCliLogLevelOption", () => {
  it("accepts allowed log levels", () => {
    expect(parseCliLogLevelOption("debug")).toBe("debug");
    expect(parseCliLogLevelOption(" trace ")).toBe("trace");
  });

  it("rejects invalid log levels", () => {
    expect(() => parseCliLogLevelOption("loud")).toThrow("Invalid --log-level");
  });
});
