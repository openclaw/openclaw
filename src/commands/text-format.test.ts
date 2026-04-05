import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("mullusi", 16)).toBe("mullusi");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("mullusi-status-output", 10)).toBe("mullusi-…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
