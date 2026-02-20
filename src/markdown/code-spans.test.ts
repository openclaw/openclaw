import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState } from "./code-spans.js";

describe("createInlineCodeState", () => {
  it("creates an initial state with open=false and ticks=0", () => {
    const state = createInlineCodeState();
    expect(state.open).toBe(false);
    expect(state.ticks).toBe(0);
  });
});

describe("buildCodeSpanIndex", () => {
  describe("basic inline code detection", () => {
    it("detects simple inline code", () => {
      const text = "Hello `world` test";
      const index = buildCodeSpanIndex(text);

      // Inside the backticks: indices 6-12 (the word "world")
      expect(index.isInside(6)).toBe(true);
      expect(index.isInside(7)).toBe(true);
      expect(index.isInside(11)).toBe(true);

      // Outside the backticks
      expect(index.isInside(0)).toBe(false);
      expect(index.isInside(5)).toBe(false);
      expect(index.isInside(13)).toBe(false);
    });

    it("detects multiple inline code spans", () => {
      const text = "First `code1` and `code2` text";
      const index = buildCodeSpanIndex(text);

      // First code span (indices 6-11)
      expect(index.isInside(6)).toBe(true);
      expect(index.isInside(10)).toBe(true);

      // Between spans
      expect(index.isInside(14)).toBe(false);

      // Second code span (indices 19-24)
      expect(index.isInside(19)).toBe(true);
      expect(index.isInside(23)).toBe(true);

      // After second span
      expect(index.isInside(26)).toBe(false);
    });
  });

  describe("fence detection", () => {
    it("ignores backticks inside fenced code blocks", () => {
      const text = "Before\n```\nlet x = `y`;\n```\nAfter";
      const index = buildCodeSpanIndex(text);

      // The backtick inside the fence should NOT be detected as code span
      // because it's inside the fence markers (``` ... ```)
      const backtickInsideFence = text.indexOf("`y`");
      expect(index.isInside(backtickInsideFence)).toBe(true); // True because it's IN the fence
      expect(index.isInside(backtickInsideFence + 1)).toBe(true);
    });

    it("detects backticks outside fences separately from backticks inside", () => {
      const text = "Text `outside` before\n```\n`inside`\n```\nText after";
      const index = buildCodeSpanIndex(text);

      // Backtick pair outside fence
      const outsideStart = text.indexOf("`outside`");
      expect(index.isInside(outsideStart)).toBe(true);

      // Backtick pair inside fence
      const insideStart = text.indexOf("`inside`");
      expect(index.isInside(insideStart)).toBe(true); // Still true, but for fence reason
    });
  });

  describe("multiple backtick counts", () => {
    it("handles backticks with double ticks", () => {
      const text = "Use ``code here`` for inline";
      const index = buildCodeSpanIndex(text);

      // Indices 4-14 should be inside the double-backtick code
      expect(index.isInside(4)).toBe(true);
      expect(index.isInside(13)).toBe(true);
      expect(index.isInside(3)).toBe(false);
      expect(index.isInside(15)).toBe(false);
    });

    it("requires matching backtick counts to close code span", () => {
      const text = "Triple ```backtick`` not closed";
      const index = buildCodeSpanIndex(text);

      // Triple backticks require triple backticks to close
      // The double backticks don't close the span, so rest of string is "inside"
      expect(index.isInside(10)).toBe(true);
      expect(index.isInside(25)).toBe(true); // Everything after opening is inside
    });
  });

  describe("unclosed code spans", () => {
    it("treats rest of text as inside if code span is not closed", () => {
      const text = "Start `unclosed code";
      const index = buildCodeSpanIndex(text);

      // After the opening backtick, everything is "inside" the unclosed span
      expect(index.isInside(7)).toBe(true);
      expect(index.isInside(15)).toBe(true);
      expect(index.isInside(19)).toBe(true);

      // Before the opening backtick is outside
      expect(index.isInside(0)).toBe(false);
    });

    it("preserves state between calls when passed previous state", () => {
      const text1 = "First part `incomplete";
      const index1 = buildCodeSpanIndex(text1);

      // The span at the end is unclosed, and we get the state
      expect(index1.inlineState.open).toBe(true);
      expect(index1.inlineState.ticks).toBe(1);

      // Now process next chunk with previous state
      const text2 = "rest of code`";
      const index2 = buildCodeSpanIndex(text2, index1.inlineState);

      // Should recognize the closing backtick at position 12
      expect(index2.isInside(0)).toBe(true); // Start of text is still in the span
      expect(index2.isInside(11)).toBe(true); // The backtick position
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const text = "";
      const index = buildCodeSpanIndex(text);
      expect(index.isInside(0)).toBe(false);
    });

    it("handles text with no backticks", () => {
      const text = "Plain text without any code markers";
      const index = buildCodeSpanIndex(text);

      expect(index.isInside(0)).toBe(false);
      expect(index.isInside(10)).toBe(false);
      expect(index.isInside(33)).toBe(false);
    });

    it("handles only backticks", () => {
      const text = "``";
      const index = buildCodeSpanIndex(text);

      // Double backticks with nothing between would be a zero-width code span
      expect(index.isInside(0)).toBe(true);
      expect(index.isInside(1)).toBe(true);
    });

    it("handles newlines in fenced blocks", () => {
      const text = "Text\n```\ncode\nmore\n```\nEnd";
      const index = buildCodeSpanIndex(text);

      // Index inside the fence
      const fenceContent = text.indexOf("code");
      expect(index.isInside(fenceContent)).toBe(true);
    });

    it("handles consecutive code spans", () => {
      const text = "`one``two`";
      const index = buildCodeSpanIndex(text);

      // First: `one` (0-4)
      expect(index.isInside(1)).toBe(true); // 'o' in 'one'

      // Second: `two` (should be 5-9, since second backtick closes first at position 4)
      // Actually: `one` is positions 0-4 (open at 0, close at 4)
      // Then `two` is positions 4-9 (open at 4, close at 9)
      // So position 4 is the open of second span, position 5-8 is inside second span
      expect(index.isInside(5)).toBe(true); // 't' in 'two'
    });
  });
});
