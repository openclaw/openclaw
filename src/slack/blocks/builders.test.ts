import { describe, expect, it } from "vitest";
import { plainText, mrkdwn, section } from "./builders.js";

describe("Text object builders — escape normalization", () => {
  it("converts literal \\n to real newlines in mrkdwn", () => {
    const result = mrkdwn("*Title*\\n\\nBody text");
    expect(result.text).toBe("*Title*\n\nBody text");
  });

  it("converts literal \\n to real newlines in plainText", () => {
    const result = plainText("Line 1\\nLine 2");
    expect(result.text).toBe("Line 1\nLine 2");
  });

  it("converts literal \\t to real tabs in mrkdwn", () => {
    const result = mrkdwn("Col1\\tCol2");
    expect(result.text).toBe("Col1\tCol2");
  });

  it("preserves already-real newlines", () => {
    const result = mrkdwn("Line 1\nLine 2");
    expect(result.text).toBe("Line 1\nLine 2");
  });

  it("handles mixed real and literal newlines", () => {
    const result = mrkdwn("Real newline\nLiteral\\nescaped");
    expect(result.text).toBe("Real newline\nLiteral\nescaped");
  });

  it("leaves text without escape sequences unchanged", () => {
    const result = mrkdwn("Hello world");
    expect(result.text).toBe("Hello world");
  });
});

describe("section builder uses mrkdwn with normalization", () => {
  it("normalizes escapes in section text", () => {
    const block = section({ text: "*Bold title*\\n\\nParagraph below" });
    expect(block.text).toEqual({
      type: "mrkdwn",
      text: "*Bold title*\n\nParagraph below",
      verbatim: false,
    });
  });
});
