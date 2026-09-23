import { describe, expect, it } from "vitest";
import { resolvePromptHistoryLimit } from "./number-runtime.js";

describe("private observed-message history policy", () => {
  it("applies channel defaults, explicit disablement, and the message ceiling", () => {
    expect(resolvePromptHistoryLimit(undefined)).toBe(50);
    expect(resolvePromptHistoryLimit(12)).toBe(12);
    expect(resolvePromptHistoryLimit(Number.MAX_SAFE_INTEGER)).toBe(50);
    expect(resolvePromptHistoryLimit(Number.MAX_SAFE_INTEGER, 10)).toBe(10);
    expect(resolvePromptHistoryLimit(0, 10)).toBe(0);
    expect(resolvePromptHistoryLimit(5000, 10)).toBe(200);
  });

  it.each([undefined, Number.MAX_SAFE_INTEGER])("bounds fallback windows for %s", (configured) => {
    expect(resolvePromptHistoryLimit(configured, 5000)).toBe(200);
    expect(resolvePromptHistoryLimit(configured, -1)).toBe(0);
    expect(resolvePromptHistoryLimit(configured, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
