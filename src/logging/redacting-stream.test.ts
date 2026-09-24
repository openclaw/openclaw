import { describe, expect, it, vi } from "vitest";
import { createRedactingStreamWriter } from "./redacting-stream.js";

describe("createRedactingStreamWriter", () => {
  it.each([
    { values: ["abcabc"], input: "abcabc", expected: "<redacted>" },
    { values: ["abcabc"], input: "abcabcabcabc", expected: "<redacted><redacted>" },
    { values: ["abc", "abcdef"], input: "abcdef abc!", expected: "<redacted> <redacted>!" },
    { values: ["bc", "abcdef"], input: "abcdef abc", expected: "<redacted> a<redacted>" },
    { values: ["abcabc", "redact"], input: "abcabc redact", expected: "<redacted> <redacted>" },
    { values: ["", "🦞密🦞"], input: "🦞密🦞 🦞!", expected: "<redacted> 🦞!" },
    { values: ["gw-secret-token"], input: "partial gw-sec", expected: "partial gw-sec" },
    { values: [], input: "progress 🦞", expected: "progress 🦞" },
  ])("redacts $input independently of byte chunk boundaries", ({ values, input, expected }) => {
    const bytes = Buffer.from(input);
    const partitions = Array.from({ length: bytes.length + 1 }, (_, index) => [
      bytes.subarray(0, index),
      bytes.subarray(index),
    ]);
    partitions.push(Array.from(bytes, (byte) => Buffer.from([byte])));
    for (const chunks of partitions) {
      let output = "";
      const writer = createRedactingStreamWriter(
        {
          write: (text) => {
            output += text;
            return true;
          },
        },
        values,
      );
      for (const chunk of chunks) {
        writer.write(chunk);
      }
      writer.flush();
      expect(output).toBe(expected);
    }
  });

  it.each(["boot ok\ntoken=", "x".repeat(64 * 1024)])(
    "streams unterminated progress with bounded carry and forwards backpressure (%#)",
    (prefix) => {
      const write = vi
        .fn<(text: string) => boolean>()
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const writer = createRedactingStreamWriter({ write }, ["gw-secret-token"]);
      expect(writer.write(Buffer.from(`${prefix}gw-sec`))).toBe(false);
      expect(write.mock.calls).toEqual([[prefix]]);
      expect(writer.write(Buffer.from("ret-token done\ntail without newline"))).toBe(true);
      expect(write.mock.calls).toEqual([[prefix], ["<redacted> done\ntail without newline"]]);
      writer.flush();
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it("holds an ambiguous secret prefix until the match is complete", () => {
    const write = vi.fn<(text: string) => boolean>().mockReturnValue(false);
    const writer = createRedactingStreamWriter({ write }, ["abc", "abcabc"]);
    expect(writer.write(Buffer.from("abc"))).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(writer.write(Buffer.from("abc"))).toBe(false);
    expect(write.mock.calls).toEqual([["<redacted>"]]);
    writer.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
