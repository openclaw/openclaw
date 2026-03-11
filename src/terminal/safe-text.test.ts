import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./safe-text.js";

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText("a\u009bb\u0085c")).toBe("abc");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });
});
