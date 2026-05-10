import { describe, expect, it } from "vitest";
import { createSilentTokenDeltaBuffer } from "./silent-token-delta-buffer.js";

describe("createSilentTokenDeltaBuffer", () => {
  it("merges split silent-token chunks before suppressing them", () => {
    const buffer = createSilentTokenDeltaBuffer("NO_REPLY");

    expect(buffer.consume("NO")).toEqual({ skip: true });
    expect(buffer.consume("_REPLY")).toEqual({ skip: true });
  });

  it("releases buffered prefix text when the next chunk proves it is not silent", () => {
    const buffer = createSilentTokenDeltaBuffer("NO_REPLY");

    expect(buffer.consume("NO")).toEqual({ skip: true });
    expect(buffer.consume("T really")).toEqual({
      text: "NOT really",
      skip: false,
    });
  });

  it("does not buffer natural-language mixed-case text", () => {
    const buffer = createSilentTokenDeltaBuffer("NO_REPLY");

    expect(buffer.consume("No")).toEqual({ text: "No", skip: false });
  });
});
