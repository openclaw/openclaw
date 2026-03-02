import { describe, expect, it } from "vitest";
import { applyDiscordAutoHardBreaks } from "./hard-breaks.js";

describe("applyDiscordAutoHardBreaks", () => {
  it("converts single newlines to markdown hard breaks", () => {
    expect(applyDiscordAutoHardBreaks("alpha\nbeta\ngamma")).toBe("alpha  \nbeta  \ngamma");
  });

  it("preserves paragraph breaks", () => {
    expect(applyDiscordAutoHardBreaks("alpha\n\nbeta")).toBe("alpha\n\nbeta");
    expect(applyDiscordAutoHardBreaks("alpha\n \nbeta")).toBe("alpha\n \nbeta");
  });

  it("does not convert newlines inside fenced code blocks", () => {
    const input = [
      "alpha",
      "beta",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
      "gamma",
      "delta",
    ].join("\n");
    const expected = [
      "alpha  ",
      "beta",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
      "gamma  ",
      "delta",
    ].join("\n");
    expect(applyDiscordAutoHardBreaks(input)).toBe(expected);
  });
});
