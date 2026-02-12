import { describe, expect, it } from "vitest";

import { normalizeSignalAccountInput } from "./signal.js";

describe("normalizeSignalAccountInput", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes formatted input", () => {
    expect(normalizeSignalAccountInput("  +1 (555) 000-1234 ")).toBe("+15550001234");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(normalizeSignalAccountInput("ok")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });
});
