import { describe, expect, it } from "vitest";
import { preserveNewlines } from "./assistant-message.js";

describe("preserveNewlines", () => {
  it("converts single newlines to hard breaks", () => {
    expect(preserveNewlines("line1\nline2")).toBe("line1  \nline2");
  });

  it("preserves paragraph breaks (double newlines)", () => {
    expect(preserveNewlines("para1\n\npara2")).toBe("para1\n\npara2");
  });

  it("handles mixed single and double newlines", () => {
    expect(preserveNewlines("a\nb\n\nc\nd")).toBe("a  \nb\n\nc  \nd");
  });

  it("handles triple newlines (preserves blank line)", () => {
    expect(preserveNewlines("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("returns text unchanged when there are no newlines", () => {
    expect(preserveNewlines("no newlines here")).toBe("no newlines here");
  });

  it("handles text that starts with a newline", () => {
    expect(preserveNewlines("\nline")).toBe("\nline");
  });

  it("does not double-convert already hard-broken lines", () => {
    expect(preserveNewlines("line1  \nline2")).toBe("line1  \nline2");
  });

  it("handles code blocks without corruption", () => {
    const input = "```\ncode\nmore code\n```";
    const result = preserveNewlines(input);
    // Inside fenced code blocks, marked ignores trailing spaces,
    // so adding them is harmless for rendering.
    expect(result).toBe("```  \ncode  \nmore code  \n```");
  });
});
