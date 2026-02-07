import { describe, expect, it } from "vitest";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

describe("normalizeInboundTextNewlines", () => {
  it("returns empty string unchanged", () => {
    expect(normalizeInboundTextNewlines("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(normalizeInboundTextNewlines("hello world")).toBe("hello world");
  });

  it("converts \\r\\n to \\n", () => {
    expect(normalizeInboundTextNewlines("a\r\nb")).toBe("a\nb");
  });

  it("converts bare \\r to \\n", () => {
    expect(normalizeInboundTextNewlines("a\rb")).toBe("a\nb");
  });

  it("converts escaped \\\\n to real \\n", () => {
    expect(normalizeInboundTextNewlines("a\\nb")).toBe("a\nb");
  });

  it("handles mixed newline styles", () => {
    expect(normalizeInboundTextNewlines("a\r\nb\\nc\rd")).toBe("a\nb\nc\nd");
  });

  it("handles multiple consecutive newlines", () => {
    expect(normalizeInboundTextNewlines("a\r\n\r\nb")).toBe("a\n\nb");
  });
});
