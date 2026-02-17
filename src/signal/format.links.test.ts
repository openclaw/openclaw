import { describe, expect, it } from "vitest";
import { markdownToSignalText } from "./format.js";

describe("markdownToSignalText", () => {
  describe("duplicate URL display", () => {
    it("does not duplicate URL when label matches URL without protocol", () => {
      // [selfh.st](http://selfh.st) should render as "selfh.st" not "selfh.st (http://selfh.st)"
      const res = markdownToSignalText("[selfh.st](http://selfh.st)");
      expect(res.text).toBe("selfh.st");
    });

    it("does not duplicate URL when label matches URL without https protocol", () => {
      const res = markdownToSignalText("[example.com](https://example.com)");
      expect(res.text).toBe("example.com");
    });

    it("does not duplicate URL when label matches URL without www prefix", () => {
      const res = markdownToSignalText("[www.example.com](https://example.com)");
      expect(res.text).toBe("www.example.com");
    });

    it("does not duplicate URL when label matches URL without trailing slash", () => {
      const res = markdownToSignalText("[example.com](https://example.com/)");
      expect(res.text).toBe("example.com");
    });

    it("does not duplicate URL when label matches URL with multiple trailing slashes", () => {
      const res = markdownToSignalText("[example.com](https://example.com///)");
      expect(res.text).toBe("example.com");
    });

    it("does not duplicate URL when label includes www but URL does not", () => {
      const res = markdownToSignalText("[example.com](https://www.example.com)");
      expect(res.text).toBe("example.com");
    });

    it("handles case-insensitive domain comparison", () => {
      const res = markdownToSignalText("[EXAMPLE.COM](https://example.com)");
      expect(res.text).toBe("EXAMPLE.COM");
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

    it("does not duplicate when label matches full URL with path", () => {
      const res = markdownToSignalText("[example.com/page](https://example.com/page)");
      expect(res.text).toBe("example.com/page");
    });
  });
});
