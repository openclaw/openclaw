import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("hanzo-bot", 16)).toBe("hanzo-bot");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("bot-status-output", 10)).toBe("bot-…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
