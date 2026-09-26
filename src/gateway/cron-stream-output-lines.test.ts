import { describe, expect, it } from "vitest";
import { remainingCronStreamLines, type BufferedOutput } from "./cron-stream-output-lines.js";

function chunk(text: string, overrides: Partial<BufferedOutput> = {}): BufferedOutput {
  return {
    channel: "stdout",
    chunk: text,
    generation: 1,
    truncatedTail: false,
    truncatedTailContinuesLine: false,
    precededByDrop: false,
    ...overrides,
  };
}

describe("remaining cron stream lines", () => {
  it.each([
    {
      name: "complete lines before a later drop",
      entries: [chunk("ready\npartial"), chunk("tail\n", { precededByDrop: "midline" })],
      lines: ["ready"],
    },
    {
      name: "a truncated tail that ended at a newline",
      entries: [chunk("part", { truncatedTail: true }), chunk("ready\n")],
      lines: ["ready"],
    },
    {
      name: "a truncated tail that continued the line",
      entries: [
        chunk("part", { truncatedTail: true, truncatedTailContinuesLine: true }),
        chunk("tail\nready\n"),
      ],
      lines: ["ready"],
    },
    {
      name: "a CRLF line whose raw bytes exceed the cap",
      entries: [chunk("12345678\r\n")],
      lines: [],
    },
    {
      name: "a CRLF line at the raw byte cap",
      entries: [chunk("1234567\r\n")],
      lines: ["1234567"],
    },
    {
      name: "an oversized line-mode partial before a later gap",
      entries: [chunk("123456789"), chunk("tail\n", { precededByDrop: "midline" })],
      lines: ["12345678"],
      includeTruncated: true,
    },
  ])("preserves intake boundaries for $name", ({ entries, lines, includeTruncated }) => {
    expect(
      Array.from(
        remainingCronStreamLines({
          partialLines: { stdout: "", stderr: "" },
          discardUntilNewline: { stdout: false, stderr: false },
          droppedChunkTail: { stdout: false, stderr: false },
          bufferedOutput: entries,
          maxLineBytes: 8,
          includeTruncated: includeTruncated ?? false,
        }),
      ),
    ).toEqual(lines);
  });
});
