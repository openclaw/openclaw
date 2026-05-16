import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, markdownToIR } from "./ir.js";

describe("chunkMarkdownIR", () => {
  it("preserves styled trailing whitespace in the final chunk", () => {
    const ir = markdownToIR("```\n123456789\n```");

    expect(ir.text).toBe("123456789\n");

    const chunks = chunkMarkdownIR(ir, 7);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["1234567", "89\n"]);
    expect(chunks.at(-1)?.styles).toEqual([{ start: 0, end: 3, style: "code_block" }]);
  });
});
