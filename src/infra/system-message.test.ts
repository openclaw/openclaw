import { describe, expect, it } from "vitest";
import { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "./system-message.js";

describe("system-message", () => {
  it.each([
    { input: "thread notice", expected: `${SYSTEM_MARK} thread notice` },
    { input: `  thread notice  `, expected: `${SYSTEM_MARK} thread notice` },
    { input: "   ", expected: "" },
  ])("prefixes %j", ({ input, expected }) => {
    expect(prefixSystemMessage(input)).toBe(expected);
  });

  it.each([
    { input: `${SYSTEM_MARK} already prefixed`, expected: true },
    { input: `  ${SYSTEM_MARK} hello`, expected: true },
    { input: SYSTEM_MARK, expected: true },
    { input: "", expected: false },
    { input: "hello", expected: false },
  ])("detects marks for %j", ({ input, expected }) => {
    expect(hasSystemMark(input)).toBe(expected);
  });

  it("does not double-prefix messages that already have the mark", () => {
    expect(prefixSystemMessage(`${SYSTEM_MARK} already prefixed`)).toBe(
      `${SYSTEM_MARK} already prefixed`,
    );
  });

  it("preserves mark-only messages after trimming", () => {
    expect(prefixSystemMessage(`  ${SYSTEM_MARK}  `)).toBe(SYSTEM_MARK);
  });
});
