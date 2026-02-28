import { describe, expect, it } from "vitest";
import { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "./system-message.js";

describe("system-message", () => {
  it("prepends the system mark once", () => {
    expect(prefixSystemMessage("thread notice")).toBe(`${SYSTEM_MARK} thread notice`);
  });

  it("does not double-prefix messages that already have the mark", () => {
    expect(prefixSystemMessage(`${SYSTEM_MARK} already prefixed`)).toBe(
      `${SYSTEM_MARK} already prefixed`,
    );
  });

  it("detects marked system text after trim normalization", () => {
    expect(hasSystemMark(`  ${SYSTEM_MARK} hello`)).toBe(true);
    expect(hasSystemMark("hello")).toBe(false);
  });
});
