import { describe, expect, it } from "vitest";
import {
  appendUtf8Lines,
  createUtf8LineAccumulator,
  flushUtf8Line,
} from "./utf8-line-accumulator.js";

describe("UTF-8 line accumulator", () => {
  it("preserves split UTF-8 and treats a split CRLF as one delimiter", () => {
    const accumulator = createUtf8LineAccumulator();
    const firstLine = Buffer.from("alpha 你好\r", "utf8");
    const utf8Split = Buffer.byteLength("alpha ") + 1;

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: firstLine.subarray(0, utf8Split),
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([]);
    expect(
      appendUtf8Lines({
        accumulator,
        chunk: firstLine.subarray(utf8Split),
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([{ line: "alpha 你好", truncated: false }]);
    expect(
      appendUtf8Lines({
        accumulator,
        chunk: "\nnext\r\n",
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([{ line: "next", truncated: false }]);
  });

  it("keeps a carriage return pending by default until a line feed arrives", () => {
    const accumulator = createUtf8LineAccumulator();

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: "alpha\r",
        maxPendingLineBytes: 8 * 1024,
      }),
    ).toEqual([]);
    expect(
      appendUtf8Lines({
        accumulator,
        chunk: "\nbeta\n",
        maxPendingLineBytes: 8 * 1024,
      }),
    ).toEqual([
      { line: "alpha", truncated: false },
      { line: "beta", truncated: false },
    ]);
  });

  it("bounds completed and trailing lines with UTF-8-safe truncation metadata", () => {
    const accumulator = createUtf8LineAccumulator();

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: `${"诊".repeat(8)}\n${"尾".repeat(8)}`,
        maxPendingLineBytes: 12,
        maxLineBytes: 12,
      }),
    ).toEqual([{ line: "诊".repeat(4), truncated: true }]);
    expect(flushUtf8Line(accumulator, 12)).toEqual({
      line: "尾".repeat(4),
      truncated: true,
    });
  });
});
