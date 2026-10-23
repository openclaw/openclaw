// Covers system-message marking and prefix idempotence.
import { describe, expect, it } from "vitest";
import { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "./system-message.js";

describe("system-message", () => {
  it.each([
    [`  thread notice  `, `${SYSTEM_MARK} thread notice`, false],
    ["   ", "", false],
    [`  ${SYSTEM_MARK} hello`, `${SYSTEM_MARK} hello`, true],
    [`  ${SYSTEM_MARK}  `, SYSTEM_MARK, true],
  ])("handles %j", (input, prefixed, marked) => {
    expect(prefixSystemMessage(input)).toBe(prefixed);
    expect(hasSystemMark(input)).toBe(marked);
  });
});
