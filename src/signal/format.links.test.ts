import { describe, expect, it } from "vitest";
import { markdownToSignalText } from "./format.js";

describe("markdownToSignalText", () => {
  describe("duplicate URL display", () => {
    it("does not duplicate URL for normalized equivalent labels", () => {
      const equivalentCases = [
        { input: "[selfh.st](http://selfh.st)", expected: "selfh.st" },
        { input: "[example.com](https://example.com)", expected: "example.com" },
        { input: "[www.example.com](https://example.com)", expected: "www.example.com" },
        { input: "[example.com](https://example.com/)", expected: "example.com" },
        { input: "[example.com](https://example.com///)", expected: "example.com" },
        { input: "[example.com](https://www.example.com)", expected: "example.com" },
        { input: "[EXAMPLE.COM](https://example.com)", expected: "EXAMPLE.COM" },
        { input: "[example.com/page](https://example.com/page)", expected: "example.com/page" },
      ] as const;

      for (const { input, expected } of equivalentCases) {
        const res = markdownToSignalText(input);
        expect(res.text).toBe(expected);
      }
    });

    it("still shows URL when label is meaningfully different", () => {
      const res = markdownToSignalText("[click here](https://example.com)");
      expect(res.text).toBe("click here (https://example.com)");
    });

    it("handles URL with path - should show URL when label is just domain", () => {
      // Label is just domain, URL has path - these are meaningfully different
      const res = markdownToSignalText("[example.com](https://example.com/page)");
      expect(res.text).toBe("example.com (https://example.com/page)");
    });
  });
});
