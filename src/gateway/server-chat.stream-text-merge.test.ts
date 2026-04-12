import { describe, expect, test } from "vitest";
import { resolveMergedAssistantText } from "./server-chat.js";

/**
 * These tests cover the chat-stream text merge helper that backs every
 * `emitChatDelta` broadcast.  The previous implementation silently dropped
 * repeated markdown structural tokens (table separators `|---|`, horizontal
 * rules `---`, code-fence markers) when the adapter streamed them as
 * incremental chunks, because a "de-duplicate overlapping suffix" heuristic
 * treated the repeat as an already-buffered trailing sequence.
 *
 * User-visible impact of the old behavior:
 *   - GFM table separator rows arrived with fewer cells than the header row,
 *     so react-markdown / remark-gfm refused to parse them as tables and
 *     every streamed assistant message containing a markdown table rendered
 *     as a wall of inline pipe characters instead.
 *   - Horizontal rules between sections disappeared.
 *   - Fenced code blocks occasionally lost one of their ``` markers, leaving
 *     the rest of the message inside an unclosed code block.
 *
 * The fix is to append deltas verbatim and trust the adapter's cumulative
 * `text` snapshot as authoritative.
 */
describe("resolveMergedAssistantText", () => {
  describe("cumulative snapshot path (nextText provided)", () => {
    test("returns the cumulative snapshot unchanged when it extends previousText", () => {
      const result = resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "Hello world",
        nextDelta: " world",
      });
      expect(result).toBe("Hello world");
    });

    test("returns the new snapshot when the adapter rewinds to an unrelated string", () => {
      // Adapter signals a rewind by sending a cumulative text that no longer
      // starts with the previous buffer.  The old code preserved this shape
      // (it fell through to `if (nextText) return nextText`) and we keep it.
      const result = resolveMergedAssistantText({
        previousText: "Draft reply",
        nextText: "Final reply",
        nextDelta: "",
      });
      expect(result).toBe("Final reply");
    });

    test("keeps the longer buffered text when the adapter resends a stale prefix with no delta", () => {
      // Defensive case: the adapter re-sends a shorter snapshot that is a
      // prefix of what we already have, and there is no incremental delta.
      // The existing contract is to ignore the stale frame.
      const result = resolveMergedAssistantText({
        previousText: "Hello world!",
        nextText: "Hello",
        nextDelta: "",
      });
      expect(result).toBe("Hello world!");
    });
  });

  describe("incremental delta path (nextDelta provided, no cumulative text)", () => {
    test("returns the delta directly on the first frame when the buffer is empty", () => {
      // With an empty `previousText`, the `nextText && previousText` guard is
      // false and the function skips the cumulative-snapshot branch entirely,
      // so the result comes from the delta path regardless of whether the
      // adapter also supplied a `nextText`.  Pinning the behavior here keeps
      // future refactors honest about the initial-frame handling.
      const result = resolveMergedAssistantText({
        previousText: "",
        nextText: "Hello",
        nextDelta: "Hello",
      });
      expect(result).toBe("Hello");
    });

    test("appends a pure delta chunk to the buffer", () => {
      const result = resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "",
        nextDelta: " world",
      });
      expect(result).toBe("Hello world");
    });

    test("uses the delta directly when the buffer is empty", () => {
      const result = resolveMergedAssistantText({
        previousText: "",
        nextText: "",
        nextDelta: "Hello",
      });
      expect(result).toBe("Hello");
    });

    test("returns previousText when both nextText and nextDelta are empty", () => {
      const result = resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "",
        nextDelta: "",
      });
      expect(result).toBe("Hello");
    });
  });

  describe("regression: repeated markdown structural tokens must not be dropped", () => {
    test("three identical |---| cells in a GFM table separator row survive when streamed as individual chunks", () => {
      // Reproduces the user-visible bug: a three-column table header
      // `| a | b | c |` needs a three-cell separator `|---|---|---|`.
      // Some tokenizers emit each separator cell as a discrete chunk.  The
      // previous `appendUniqueSuffix` helper hit the `base.endsWith(suffix)`
      // shortcut on every cell after the first, so the buffer stopped
      // growing after the second cell and the separator row ended up with
      // fewer cells than the header — GFM parsers then refused to render
      // the whole table.
      let acc = "";
      for (const chunk of ["|---|", "|---|", "|---|"]) {
        acc = resolveMergedAssistantText({
          previousText: acc,
          nextText: "",
          nextDelta: chunk,
        });
      }
      expect(acc).toBe("|---||---||---|");
    });

    test("repeated horizontal rules between paragraphs are not collapsed", () => {
      // Adapter emits a horizontal rule twice as the LLM separates two
      // sections of a response.  The old overlap heuristic matched the full
      // `---\n` tail of the buffer against the new suffix and collapsed
      // them.
      let acc = "Section A\n---\n";
      acc = resolveMergedAssistantText({
        previousText: acc,
        nextText: "",
        nextDelta: "Section B\n---\n",
      });
      acc = resolveMergedAssistantText({
        previousText: acc,
        nextText: "",
        nextDelta: "Section C",
      });
      expect(acc).toBe("Section A\n---\nSection B\n---\nSection C");
    });

    test("closing code fence ``` after an open fence ``` is not dropped", () => {
      // Fenced code block: the opening and closing fences are both "```".
      // The old heuristic dropped the closing fence as a duplicate suffix,
      // leaving the rest of the message rendered inside an open code block.
      let acc = "```";
      acc = resolveMergedAssistantText({
        previousText: acc,
        nextText: "",
        nextDelta: "ts\nconsole.log(1);\n",
      });
      acc = resolveMergedAssistantText({
        previousText: acc,
        nextText: "",
        nextDelta: "```",
      });
      expect(acc).toBe("```ts\nconsole.log(1);\n```");
    });

    test("incremental delta is never truncated when it shares a prefix with the buffer tail", () => {
      // Old behavior: the `for (overlap = maxOverlap; overlap > 0; ...)`
      // loop found the shared suffix and sliced it off the incoming delta.
      // A stream containing "abcabc" (the model writing the same short
      // pattern twice) was collapsed to "abc" + "" and the second copy was
      // lost.  This is exactly how repeated short code identifiers or short
      // markdown constructs get mangled in flight.
      const result = resolveMergedAssistantText({
        previousText: "abc",
        nextText: "",
        nextDelta: "abc",
      });
      expect(result).toBe("abcabc");
    });

    test("overlap heuristic no longer fires on a coincidental shared substring", () => {
      // A more realistic incremental case where the tail of the buffer
      // happens to match the head of the next token.  Under the old helper,
      // the 2-char "er" overlap was sliced off "error" -> "ror", silently
      // corrupting the message.
      const result = resolveMergedAssistantText({
        previousText: "The user",
        nextText: "",
        nextDelta: "er error",
      });
      expect(result).toBe("The userer error");
    });
  });

  describe("no regression on the normal cumulative-snapshot hot path", () => {
    test("long streaming sequence of proper prefix extensions matches the final snapshot", () => {
      // Simulate a well-behaved adapter emitting cumulative snapshots only
      // (most providers do this).  The delta branch should never fire.
      const frames = [
        { nextText: "H", nextDelta: "H" },
        { nextText: "He", nextDelta: "e" },
        { nextText: "Hel", nextDelta: "l" },
        { nextText: "Hell", nextDelta: "l" },
        { nextText: "Hello", nextDelta: "o" },
        { nextText: "Hello ", nextDelta: " " },
        { nextText: "Hello w", nextDelta: "w" },
        { nextText: "Hello wo", nextDelta: "o" },
        { nextText: "Hello wor", nextDelta: "r" },
        { nextText: "Hello worl", nextDelta: "l" },
        { nextText: "Hello world", nextDelta: "d" },
      ];
      let acc = "";
      for (const frame of frames) {
        acc = resolveMergedAssistantText({
          previousText: acc,
          nextText: frame.nextText,
          nextDelta: frame.nextDelta,
        });
      }
      expect(acc).toBe("Hello world");
    });
  });
});
