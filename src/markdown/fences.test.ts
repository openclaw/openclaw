import { describe, expect, it } from "vitest";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "./fences.js";

describe("parseFenceSpans", () => {
  describe("basic fence detection", () => {
    it("detects backtick fence with 3+ backticks", () => {
      const text = "Before\n```\ncode\n```\nAfter";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].marker).toBe("```");
      expect(spans[0].markerChar).toBe("`");
    });

    it("detects tilde fence with 3+ tildes", () => {
      const text = "Before\n~~~\ncode\n~~~\nAfter";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].marker).toBe("~~~");
      expect(spans[0].markerChar).toBe("~");
    });

    it("treats 4+ backticks same as 3", () => {
      const text = "Before\n````\ncode\n```\nAfter";
      const spans = parseFenceSpans(text);

      // 4 backticks opens, but 3 backticks close (3 >= 4 is false, so doesn't close)
      // Need 4 backticks to close
      expect(spans).toHaveLength(1);
      // This fence starts at "Before\n" and ends at the 3 backticks line
      // But 3 < 4, so it doesn't close, fence extends to end
      expect(spans[0].marker).toBe("````");
    });

    it("requires closing marker to be >= opening marker length", () => {
      const text = "~~~\ncode\n~~~~\n";
      const spans = parseFenceSpans(text);

      // 3 tildes open, 4 tildes close (4 >= 3 is true)
      expect(spans).toHaveLength(1);
      expect(spans[0].marker).toBe("~~~");
    });
  });

  describe("fence boundaries and positions", () => {
    it("records correct start/end positions", () => {
      const text = "start\n```\ncode here\n```\nend";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].start).toBe(6); // Position of first "```" line
      expect(spans[0].end).toBe(26); // Position after "```" (closing marker line)
    });

    it("includes fence markers in span boundaries", () => {
      const text = "```\nhello\n```";
      const spans = parseFenceSpans(text);

      expect(spans[0].start).toBe(0); // Start of opening ```
      expect(spans[0].end).toBe(13); // End of closing ```
    });
  });

  describe("fence metadata", () => {
    it("captures openLine and indent", () => {
      const text = "  ```js\ncode\n```";
      const spans = parseFenceSpans(text);

      expect(spans[0].indent).toBe("  "); // The 2-space indent
      expect(spans[0].openLine).toBe("  ```js"); // Full open line
      expect(spans[0].marker).toBe("```");
    });

    it("allows 0-3 spaces of indent", () => {
      const text = "   ```\ncode\n```"; // 3 spaces
      const spans = parseFenceSpans(text);
      expect(spans).toHaveLength(1);

      const text4 = "    ```\ncode\n```"; // 4 spaces = not a fence!
      const spans4 = parseFenceSpans(text4);
      expect(spans4).toHaveLength(0); // 4 spaces = code indentation, not fence
    });
  });

  describe("multiple fences", () => {
    it("detects multiple separate fences", () => {
      const text = "```\nfirst\n```\ntext\n```\nsecond\n```";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(2);
      expect(spans[0].marker).toBe("```");
      expect(spans[1].marker).toBe("```");
    });

    it("handles nested/overlapping fence markers", () => {
      const text = "```\ncode with ``` inside\n```";
      const spans = parseFenceSpans(text);

      // The ``` inside the fence doesn't close it (need exact marker count)
      expect(spans).toHaveLength(1);
      expect(spans[0].start).toBe(0);
    });

    it("switches between backtick and tilde fences", () => {
      const text = "```\ncode1\n```\n~~~\ncode2\n~~~";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(2);
      expect(spans[0].markerChar).toBe("`");
      expect(spans[1].markerChar).toBe("~");
    });
  });

  describe("unclosed fences", () => {
    it("extends unclosed fence to end of buffer", () => {
      const text = "```\ncode but no closing";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].end).toBe(text.length);
    });

    it("handles unclosed fence at end of file", () => {
      const text = "Start\n```\ncode";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].end).toBe(text.length);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const spans = parseFenceSpans("");
      expect(spans).toHaveLength(0);
    });

    it("handles string with no fences", () => {
      const text = "Just plain text\nwith no markers";
      const spans = parseFenceSpans(text);
      expect(spans).toHaveLength(0);
    });

    it("ignores less than 3 backticks", () => {
      const text = "`` \n code\n ``";
      const spans = parseFenceSpans(text);
      expect(spans).toHaveLength(0);
    });

    it("ignores mixed marker types for open/close", () => {
      const text = "```\ncode\n~~~\nmore";
      const spans = parseFenceSpans(text);

      // 3 backticks open, but ~~~ doesn't close (different marker)
      expect(spans).toHaveLength(1);
      expect(spans[0].end).toBe(text.length); // Unclosed, extends to end
    });

    it("handles single line fence attempt", () => {
      const text = "``` code ```";
      const spans = parseFenceSpans(text);

      // Text after ``` on same line is info string, not code
      // Need newline to start code content
      expect(spans).toHaveLength(1);
    });

    it("handles only fence markers", () => {
      const text = "```\n```";
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0].start).toBe(0);
      expect(spans[0].end).toBe(8);
    });
  });
});

describe("findFenceSpanAt", () => {
  it("finds fence containing the given index", () => {
    const text = "before\n```\ncode here\n```\nafter";
    const spans = parseFenceSpans(text);

    // Index inside fence content
    const fenceStart = text.indexOf("code");
    expect(findFenceSpanAt(spans, fenceStart)).toBeDefined();
    expect(findFenceSpanAt(spans, fenceStart)?.marker).toBe("```");
  });

  it("returns undefined for index outside any fence", () => {
    const text = "```\ncode\n```";
    const spans = parseFenceSpans(text);

    expect(findFenceSpanAt(spans, 0)).toBeUndefined(); // On opening marker
    expect(findFenceSpanAt(spans, 5)).toBeDefined(); // Inside fence
  });

  it("returns undefined for index on boundary", () => {
    const text = "```\ncode\n```";
    const spans = parseFenceSpans(text);
    const fenceSpan = spans[0];

    // Test expects index > start and < end (exclusive on both sides)
    expect(findFenceSpanAt(spans, fenceSpan.start)).toBeUndefined(); // Not >
    expect(findFenceSpanAt(spans, fenceSpan.end)).toBeUndefined(); // Not <
    expect(findFenceSpanAt(spans, fenceSpan.start + 1)).toBeDefined(); // Inside
  });
});

describe("isSafeFenceBreak", () => {
  it("returns true when index is not inside any fence", () => {
    const text = "before\n```\ncode\n```\nafter";
    const spans = parseFenceSpans(text);

    expect(isSafeFenceBreak(spans, 0)).toBe(true); // Before fence
    expect(isSafeFenceBreak(spans, text.indexOf("after"))).toBe(true); // After fence
  });

  it("returns false when index is inside a fence", () => {
    const text = "```\ncode\n```";
    const spans = parseFenceSpans(text);

    const insideIndex = text.indexOf("code");
    expect(isSafeFenceBreak(spans, insideIndex)).toBe(false);
  });

  it("returns true at fence boundaries", () => {
    const text = "```\ncode\n```";
    const spans = parseFenceSpans(text);

    // Boundaries are NOT inside (uses strict < and >)
    expect(isSafeFenceBreak(spans, spans[0].start)).toBe(true);
    expect(isSafeFenceBreak(spans, spans[0].end)).toBe(true);
  });
});
