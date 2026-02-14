import { describe, expect, it } from "vitest";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

describe("normalizeInboundTextNewlines", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeInboundTextNewlines("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts CR to LF", () => {
    expect(normalizeInboundTextNewlines("hello\rworld")).toBe("hello\nworld");
  });

  it("preserves literal backslash-n sequences in Windows paths", () => {
    // Windows paths like C:\Work\nxxx should NOT have \n converted to newlines
    const windowsPath = "C:\\Work\\nxxx\\README.md";
    expect(normalizeInboundTextNewlines(windowsPath)).toBe("C:\\Work\\nxxx\\README.md");
  });

  it("preserves backslash-n in messages containing Windows paths", () => {
    const message = "Please read the file at C:\\Work\\nxxx\\README.md";
    expect(normalizeInboundTextNewlines(message)).toBe(
      "Please read the file at C:\\Work\\nxxx\\README.md",
    );
  });

  it("preserves multiple backslash-n sequences", () => {
    const message = "C:\\new\\notes\\nested";
    expect(normalizeInboundTextNewlines(message)).toBe("C:\\new\\notes\\nested");
  });

  it("still normalizes actual CRLF while preserving backslash-n", () => {
    const message = "Line 1\r\nC:\\Work\\nxxx";
    expect(normalizeInboundTextNewlines(message)).toBe("Line 1\nC:\\Work\\nxxx");
  });
});
