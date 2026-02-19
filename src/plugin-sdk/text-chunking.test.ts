import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./text-chunking.js";

describe("chunkTextForOutbound", () => {
  it("returns empty for empty input", () => {
    expect(chunkTextForOutbound("", 10)).toEqual([]);
  });

  it("splits on newline or whitespace boundaries", () => {
    expect(chunkTextForOutbound("alpha\nbeta gamma", 8)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("falls back to hard limit when no separator exists", () => {
    expect(chunkTextForOutbound("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
