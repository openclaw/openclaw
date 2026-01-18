import { describe, expect, it } from "vitest";

import { normalizeInboundTextNewlines } from "./inbound-text.js";

describe("normalizeInboundTextNewlines", () => {
  it("keeps real newlines", () => {
    expect(normalizeInboundTextNewlines("a\nb")).toBe("a\nb");
  });

  it("normalizes CRLF/CR to LF", () => {
    expect(normalizeInboundTextNewlines("a\r\nb")).toBe("a\nb");
    expect(normalizeInboundTextNewlines("a\rb")).toBe("a\nb");
  });

  it("decodes literal \\\\n to newlines when no real newlines exist", () => {
    expect(normalizeInboundTextNewlines("a\\nb")).toBe("a\nb");
  });
});
