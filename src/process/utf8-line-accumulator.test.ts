import { describe, expect, it } from "vitest";
import {
  appendUtf8Lines,
  createUtf8LineAccumulator,
  flushUtf8Line,
} from "./utf8-line-accumulator.js";

describe("UTF-8 line accumulator", () => {
  it("flushes pending UTF-8 bytes before a following string delimiter", () => {
    const accumulator = createUtf8LineAccumulator();
    expect(
      appendUtf8Lines({ accumulator, chunk: Buffer.from([0xe4]), maxPendingLineBytes: 8192 }),
    ).toEqual([]);
    expect(appendUtf8Lines({ accumulator, chunk: "\n", maxPendingLineBytes: 8192 })).toEqual([
      { line: "�", truncated: false },
    ]);
  });

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
        chunk: Buffer.alloc(0),
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([]);
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

  it("can emit UTF-8-complete progress fragments without retaining them", () => {
    const accumulator = createUtf8LineAccumulator();
    const split = Buffer.from("loading 你", "utf8");

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: split.subarray(0, -1),
        maxPendingLineBytes: 8192,
        splitOnCarriageReturn: true,
        emitPending: true,
      }),
    ).toEqual([{ line: "loading ", truncated: false }]);
    expect(
      appendUtf8Lines({
        accumulator,
        chunk: split.subarray(-1),
        maxPendingLineBytes: 8192,
        splitOnCarriageReturn: true,
        emitPending: true,
      }),
    ).toEqual([{ line: "你", truncated: false }]);
    expect(flushUtf8Line(accumulator, 8192)).toBeUndefined();
  });

  it("applies completed-line bounds to emitted progress fragments", () => {
    const accumulator = createUtf8LineAccumulator();

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: "12345",
        maxPendingLineBytes: 8192,
        maxLineBytes: 4,
        emitPending: true,
      }),
    ).toEqual([{ line: "2345", truncated: true }]);
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
